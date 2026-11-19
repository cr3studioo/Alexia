// SPDX-License-Identifier: AGPL-3.0-only
//! P1-09: the Telegram Bot API client against a fake Bot API speaking raw HTTP/1.1.

use std::sync::Arc;
use std::time::{Duration, Instant};

use alexia_gateway::channels::telegram::api::{Api, FILE_MAX};
use alexia_gateway::Error;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The token, built at runtime so no credential-shaped literal sits in the source.
fn token() -> String {
    format!("{}:{}", "123456", "fake-test-secret-value")
}

/// One request the fake saw.
#[derive(Debug)]
struct Seen {
    path: String,
    content_type: String,
    body: Vec<u8>,
}

impl Seen {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// What the fake answers: `Some((status, body))`, or `None` to hold the request open.
type Route = Arc<dyn Fn(&Seen) -> Option<(u16, Vec<u8>)> + Send + Sync>;

/// How long the fake waits before answering a request.
type Delay = Arc<dyn Fn(&Seen) -> Duration + Send + Sync>;

/// A fake Bot API: every connection is one request, answered by `route` then closed.
async fn fake(route: Route) -> (String, mpsc::UnboundedReceiver<Seen>) {
    fake_slow(route, Arc::new(|_| Duration::ZERO)).await
}

/// Like `fake`, but sleeps `delay(&seen)` before writing the answer.
async fn fake_slow(route: Route, delay: Delay) -> (String, mpsc::UnboundedReceiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let route = route.clone();
            let delay = delay.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut byte = [0u8; 8192];
                let header_end = loop {
                    let n = sock.read(&mut byte).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&byte[..n]);
                    if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buf[..header_end]).to_string();
                let lower = headers.to_lowercase();
                let header = |name: &str| {
                    lower
                        .lines()
                        .find_map(|l| l.strip_prefix(name))
                        .map(|v| v.trim().to_owned())
                };
                let length: usize = header("content-length:").map_or(0, |v| v.parse().unwrap());
                while buf.len() < header_end + length {
                    let n = sock.read(&mut byte).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&byte[..n]);
                }
                let path = headers.split(' ').nth(1).unwrap_or("").to_owned();
                let seen = Seen {
                    path,
                    content_type: header("content-type:").unwrap_or_default(),
                    body: buf[header_end..].to_vec(),
                };
                let answer = route(&seen);
                let wait = delay(&seen);
                let _ = tx.send(seen);
                tokio::time::sleep(wait).await;
                let Some((status, body)) = answer else {
                    tokio::time::sleep(Duration::from_secs(600)).await;
                    return;
                };
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.flush().await;
            });
        }
    });
    (base, rx)
}

/// A fake that answers every request with `status` and `body`.
async fn answering(status: u16, body: Value) -> (Api, mpsc::UnboundedReceiver<Seen>) {
    let bytes = body.to_string().into_bytes();
    let (base, rx) = fake(Arc::new(move |_| Some((status, bytes.clone())))).await;
    (Api::new(&base, token()), rx)
}

fn ok(result: Value) -> Value {
    json!({"ok": true, "result": result})
}

fn sent() -> Value {
    ok(json!({"message_id": 77, "date": 1, "chat": {"id": 5, "type": "private"}}))
}

#[tokio::test]
async fn get_updates_parses_text_photo_voice_callback_and_stop() {
    let chat = json!({"id": 5, "type": "private", "first_name": "Owner"});
    let from = json!({"id": 5, "is_bot": false, "first_name": "Owner", "username": "owner", "language_code": "en"});
    let updates = json!([
        {"update_id": 100, "message": {"message_id": 1, "date": 1700000000, "chat": chat, "from": from, "text": "hello"}},
        {"update_id": 101, "message": {"message_id": 2, "date": 1700000001, "chat": chat, "from": from,
            "caption": "a sunset",
            "photo": [
                {"file_id": "small", "file_unique_id": "s", "width": 90, "height": 60, "file_size": 1200},
                {"file_id": "big", "file_unique_id": "b", "width": 1280, "height": 853, "file_size": 98000}
            ]}},
        {"update_id": 102, "message": {"message_id": 3, "date": 1700000002, "chat": chat, "from": from,
            "voice": {"file_id": "v1", "file_unique_id": "vu", "duration": 4, "mime_type": "audio/ogg", "file_size": 9000}}},
        {"update_id": 103, "callback_query": {"id": "cb1", "from": from, "chat_instance": "ci",
            "message": {"message_id": 4, "date": 1700000003, "chat": chat, "text": "Allow?"},
            "data": "tok123"}},
        {"update_id": 104, "stopped_message_generation": {"chat": chat, "draft_id": 424242}}
    ]);
    let (api, mut rx) = answering(200, ok(updates)).await;
    let got = api
        .get_updates(100, 50, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(got.len(), 5);

    let text = got[0].message.as_ref().unwrap();
    assert_eq!(got[0].update_id, 100);
    assert_eq!(text.text.as_deref(), Some("hello"));
    assert_eq!(text.chat.id, 5);
    assert_eq!(text.chat.kind, "private");
    let user = text.from.as_ref().unwrap();
    assert!(!user.is_bot);
    assert_eq!(user.username.as_deref(), Some("owner"));
    assert!(text.photo.is_empty());

    let photo = got[1].message.as_ref().unwrap();
    assert_eq!(photo.caption.as_deref(), Some("a sunset"));
    assert_eq!(photo.photo.len(), 2);
    assert_eq!(photo.photo[1].file_id, "big");
    assert_eq!((photo.photo[1].width, photo.photo[1].height), (1280, 853));
    assert_eq!(photo.photo[1].file_size, Some(98000));

    let voice = got[2].message.as_ref().unwrap().voice.as_ref().unwrap();
    assert_eq!(voice.file_id, "v1");
    assert_eq!(voice.duration, Some(4));
    assert_eq!(voice.mime_type.as_deref(), Some("audio/ogg"));

    let press = got[3].callback_query.as_ref().unwrap();
    assert_eq!(press.id, "cb1");
    assert_eq!(press.data.as_deref(), Some("tok123"));
    assert_eq!(press.message.as_ref().unwrap().message_id, 4);
    assert!(got[3].message.is_none());

    let stop = got[4].stopped_message_generation.as_ref().unwrap();
    assert_eq!(stop.draft_id, 424242);
    assert_eq!(stop.chat.id, 5);

    let seen = rx.recv().await.unwrap();
    assert!(seen.path.ends_with("/getUpdates"));
    assert_eq!(
        seen.json(),
        json!({"offset": 100, "timeout": 50,
            "allowed_updates": ["message", "callback_query", "stopped_message_generation"]})
    );
}

#[tokio::test]
async fn reaction_body_shape() {
    let (api, mut rx) = answering(200, ok(json!(true))).await;
    api.set_reaction(5, 9, "👀").await.unwrap();
    let seen = rx.recv().await.unwrap();
    assert_eq!(seen.path, format!("/bot{}/setMessageReaction", token()));
    assert_eq!(
        seen.json(),
        json!({"chat_id": 5, "message_id": 9, "reaction": [{"type": "emoji", "emoji": "👀"}]})
    );
}

#[tokio::test]
async fn draft_body_shape() {
    let (api, mut rx) = answering(200, ok(json!(true))).await;
    api.send_draft(5, 31337, "thinking", true).await.unwrap();
    api.send_draft(5, 31337, "thinking more", false)
        .await
        .unwrap();
    let first = rx.recv().await.unwrap();
    assert!(first.path.ends_with("/sendMessageDraft"));
    assert_eq!(
        first.json(),
        json!({"chat_id": 5, "draft_id": 31337, "text": "thinking", "can_stop": true})
    );
    assert_eq!(
        rx.recv().await.unwrap().json(),
        json!({"chat_id": 5, "draft_id": 31337, "text": "thinking more"})
    );
}

#[tokio::test]
async fn buttons_body_shape() {
    let (api, mut rx) = answering(200, sent()).await;
    let buttons = [
        ("Allow".to_owned(), "t1".to_owned()),
        ("Deny".to_owned(), "t2".to_owned()),
    ];
    let id = api
        .send_message(5, "May I?", Some(&buttons), Some(3))
        .await
        .unwrap();
    assert_eq!(id, 77);
    let seen = rx.recv().await.unwrap();
    assert!(seen.path.ends_with("/sendMessage"));
    assert_eq!(
        seen.json(),
        json!({"chat_id": 5, "text": "May I?", "disable_web_page_preview": true,
            "reply_markup": {"inline_keyboard": [[
                {"text": "Allow", "callback_data": "t1"},
                {"text": "Deny", "callback_data": "t2"}
            ]]},
            "reply_parameters": {"message_id": 3}})
    );

    api.remove_buttons(5, 77).await.unwrap();
    assert_eq!(
        rx.recv().await.unwrap().json(),
        json!({"chat_id": 5, "message_id": 77, "reply_markup": {"inline_keyboard": []}})
    );
    api.answer_callback("cb1", Some("Done")).await.unwrap();
    assert_eq!(
        rx.recv().await.unwrap().json(),
        json!({"callback_query_id": "cb1", "text": "Done"})
    );
}

#[tokio::test]
async fn status_409_is_conflict() {
    let body = json!({"ok": false, "error_code": 409,
        "description": "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"});
    let (api, _rx) = answering(409, body).await;
    let err = api
        .get_updates(0, 50, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Conflict), "{err:?}");
}

#[tokio::test]
async fn status_429_is_rate_limited_with_ms() {
    let body = json!({"ok": false, "error_code": 429,
        "description": "Too Many Requests: retry after 7", "parameters": {"retry_after": 7}});
    let (api, _rx) = answering(429, body).await;
    let err = api.send_message(5, "hi", None, None).await.unwrap_err();
    assert!(
        matches!(
            err,
            Error::RateLimited {
                retry_after_ms: 7000
            }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn status_429_huge_retry_after_is_clamped() {
    let body = json!({"ok": false, "error_code": 429,
        "description": "Too Many Requests", "parameters": {"retry_after": u64::MAX}});
    let (api, _rx) = answering(429, body).await;
    let err = api.send_message(5, "hi", None, None).await.unwrap_err();
    assert!(
        matches!(
            err,
            Error::RateLimited {
                retry_after_ms: 3_600_000
            }
        ),
        "{err:?}"
    );
}

#[tokio::test]
async fn voice_upload_outlives_the_call_timeout() {
    let bytes = sent().to_string().into_bytes();
    let (base, _rx) = fake_slow(
        Arc::new(move |_| Some((200, bytes.clone()))),
        Arc::new(|_| Duration::from_secs(16)),
    )
    .await;
    let api = Api::new(&base, token());
    let id = api.send_voice(5, b"OggS\x00slow".to_vec(), None).await;
    assert!(matches!(id, Ok(77)), "{id:?}");
}

#[tokio::test]
async fn download_outlives_the_call_timeout() {
    let (base, _rx) = fake_slow(
        Arc::new(|seen: &Seen| {
            if seen.path.ends_with("/getFile") {
                let file = json!({"file_id": "f", "file_unique_id": "u", "file_size": 5, "file_path": "docs/slow.bin"});
                Some((200, ok(file).to_string().into_bytes()))
            } else {
                Some((200, b"slow!".to_vec()))
            }
        }),
        Arc::new(|seen: &Seen| {
            if seen.path.ends_with("/getFile") {
                Duration::ZERO
            } else {
                Duration::from_secs(16)
            }
        }),
    )
    .await;
    let api = Api::new(&base, token());
    assert_eq!(api.download("f").await.unwrap(), b"slow!");
}

#[tokio::test]
async fn status_401_is_unauthorized() {
    let body = json!({"ok": false, "error_code": 401, "description": "Unauthorized"});
    let (api, _rx) = answering(401, body).await;
    assert!(matches!(api.get_me().await, Err(Error::Unauthorized)));
    assert!(matches!(
        api.chat_action(5, "typing").await,
        Err(Error::Unauthorized)
    ));

    // A malformed token answers 404 on getMe: still the token's fault.
    let body = json!({"ok": false, "error_code": 404, "description": "Not Found"});
    let (api, _rx) = answering(404, body).await;
    assert!(matches!(api.get_me().await, Err(Error::Unauthorized)));
    // Elsewhere a 404 is Telegram's sentence.
    let err = api.edit_message(5, 1, "x").await.unwrap_err();
    assert!(
        matches!(&err, Error::Service(s) if s == "Not Found"),
        "{err:?}"
    );
}

#[tokio::test]
async fn too_long_is_service_with_telegrams_sentence() {
    let body =
        json!({"ok": false, "error_code": 400, "description": "Bad Request: message is too long"});
    let (api, _rx) = answering(400, body).await;
    let err = api.send_message(5, "x", None, None).await.unwrap_err();
    assert!(
        matches!(&err, Error::Service(s) if s.contains("message is too long")),
        "{err:?}"
    );
}

#[tokio::test]
async fn voice_upload_is_multipart() {
    let (api, mut rx) = answering(200, sent()).await;
    let ogg = b"OggS\x00fake-opus-bytes".to_vec();
    let id = api.send_voice(5, ogg.clone(), Some(3)).await.unwrap();
    assert_eq!(id, 77);
    let seen = rx.recv().await.unwrap();
    assert!(seen.path.ends_with("/sendVoice"));
    assert!(
        seen.content_type
            .starts_with("multipart/form-data; boundary="),
        "{}",
        seen.content_type
    );
    let body = String::from_utf8_lossy(&seen.body);
    assert!(body.contains("name=\"chat_id\"\r\n\r\n5\r\n"), "{body}");
    assert!(
        body.contains("name=\"voice\"; filename=\"reply.ogg\""),
        "{body}"
    );
    assert!(body.contains("content-type: audio/ogg") || body.contains("Content-Type: audio/ogg"));
    assert!(seen.body.windows(ogg.len()).any(|w| w == ogg.as_slice()));
    assert!(body.contains("name=\"reply_parameters\"\r\n\r\n{\"message_id\":3}"));

    let id = api
        .send_document(5, "notes.txt", "text/plain", b"hello".to_vec())
        .await
        .unwrap();
    assert_eq!(id, 77);
    let seen = rx.recv().await.unwrap();
    assert!(seen.path.ends_with("/sendDocument"));
    let body = String::from_utf8_lossy(&seen.body);
    assert!(
        body.contains("name=\"document\"; filename=\"notes.txt\""),
        "{body}"
    );
    assert!(body.contains("hello"));
}

#[tokio::test]
async fn download_writes_file_and_refuses_over_20mb() {
    let content = b"\xff\xd8\xffjpeg-bytes".to_vec();
    let served = content.clone();
    let (base, mut rx) = fake(Arc::new(move |seen: &Seen| {
        if seen.path.ends_with("/getFile") {
            let id = seen.json()["file_id"].as_str().unwrap().to_owned();
            let size = if id == "huge" { FILE_MAX + 1 } else { 13 };
            let file = json!({"file_id": id, "file_unique_id": "u", "file_size": size, "file_path": "photos/file_1.jpg"});
            Some((200, ok(file).to_string().into_bytes()))
        } else {
            Some((200, served.clone()))
        }
    }))
    .await;
    let api = Api::new(&base, token());
    assert_eq!(api.download("small").await.unwrap(), content);
    assert!(rx.recv().await.unwrap().path.ends_with("/getFile"));
    assert_eq!(
        rx.recv().await.unwrap().path,
        format!("/file/bot{}/photos/file_1.jpg", token())
    );

    let err = api.download("huge").await.unwrap_err();
    assert!(
        matches!(&err, Error::Service(s) if s.contains("20 MB")),
        "{err:?}"
    );
    // Refused at getFile: the file itself was never fetched.
    assert!(rx.recv().await.unwrap().path.ends_with("/getFile"));
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn token_never_in_errors() {
    // Port 1 on loopback: nothing listens, so the connect fails.
    let api = Api::new("http://127.0.0.1:1", token());
    let err = api.get_me().await.unwrap_err();
    assert!(matches!(err, Error::Unreachable), "{err:?}");
    let shown = format!("{err} {err:?} {api:?}");
    assert!(!shown.contains(&token()), "{shown}");
    assert!(!shown.contains("fake-test-secret-value"), "{shown}");
    assert!(format!("{api:?}").contains("127.0.0.1:1"));
}

#[tokio::test]
async fn cancel_ends_long_poll() {
    let (base, mut rx) = fake(Arc::new(|_| None)).await;
    let api = Arc::new(Api::new(&base, token()));
    let cancel = CancellationToken::new();
    let poll = tokio::spawn({
        let api = api.clone();
        let cancel = cancel.clone();
        async move { api.get_updates(0, 50, &cancel).await }
    });
    // The fake has the request and is holding it.
    tokio::time::timeout(Duration::from_secs(30), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let at = Instant::now();
    cancel.cancel();
    let got = tokio::time::timeout(Duration::from_secs(10), poll)
        .await
        .expect("cancel didn't end the poll")
        .unwrap();
    assert!(matches!(got, Err(Error::Cancelled)), "{got:?}");
    // Spec: 100 ms. Generous bound for a loaded machine; the poll's own timeout is 60 s.
    assert!(at.elapsed() < Duration::from_secs(5), "{:?}", at.elapsed());
}
