// SPDX-License-Identifier: AGPL-3.0-only

//! The one thing on this computer another computer can reach: the host service core names, and
//! on it only the operations core lists.
//!
//! The address is a **port and nothing more** — the host is always `127.0.0.1`, so there is no
//! value core could send that points the forwarder at another machine. An operation is a method
//! and a path; a request for anything else is refused before a connection is opened.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::constants::{OPERATIONS_MAX, PATH_MAX};
use crate::error::{ApiError, BAD_REQUEST};

/// `PUT /v1/host`. No `Debug`: it carries the host service's secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    port: u16,
    #[serde(default)]
    secret: Option<String>,
    operations: Vec<Operation>,
}

/// One thing a paired computer may ask for. In `path`, a segment written `:name` stands for
/// exactly one segment of the request — a job or artifact id — and everything else is literal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub name: String,
    pub method: String,
    pub path: String,
}

pub struct Host {
    pub port: u16,
    pub secret: Option<String>,
    pub operations: Vec<Operation>,
}

impl Host {
    pub fn new(registration: Registration) -> Result<Arc<Self>, ApiError> {
        let Registration { port, secret, operations } = registration;
        let bad = |message: &str| Err(ApiError::new(BAD_REQUEST, message));
        if port == 0 {
            return bad("port is not a port");
        }
        if secret.as_deref().is_some_and(|secret| secret.is_empty() || !visible(secret)) {
            return bad("secret is not something a header can carry");
        }
        if operations.len() > OPERATIONS_MAX {
            return bad("too many operations");
        }
        for operation in &operations {
            let named = !operation.name.is_empty()
                && operation.name.len() <= 64
                && operation.name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte));
            if !named {
                return bad("an operation's name is 1 to 64 of a-z, 0-9, '.', '_' and '-'");
            }
            if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&operation.method.as_str()) {
                return bad("an operation's method is GET, POST, PUT, PATCH or DELETE");
            }
            let template = operation.path.strip_prefix('/').map(|rest| rest.split('/'));
            let shaped = template.is_some_and(|mut segments| {
                segments.all(|segment| segment.strip_prefix(':').map_or(plain(segment), plain))
            });
            if !shaped || operation.path.len() > PATH_MAX {
                return bad("an operation's path is '/' and segments of A-Z, a-z, 0-9, '.', '_', '~' and '-', or ':name'");
            }
        }
        Ok(Arc::new(Self { port, secret, operations }))
    }

    /// The operation a request is for, if it is for one. `path` is as it came, query and all;
    /// the query is the host service's to read and takes no part in the match.
    pub fn operation(&self, method: &str, path: &str) -> Option<&Operation> {
        if path.len() > PATH_MAX || !visible(path) {
            return None;
        }
        let route = path.split('?').next()?.strip_prefix('/')?;
        self.operations.iter().find(|operation| {
            let mut asked = route.split('/');
            let mut template = operation.path[1..].split('/');
            operation.method == method
                && template.by_ref().all(|expected| {
                    asked.next().is_some_and(|segment| match expected.strip_prefix(':') {
                        Some(_) => plain(segment),
                        None => segment == expected,
                    })
                })
                && asked.next().is_none()
        })
    }
}

/// One path segment with nothing clever in it: no `.`/`..`, no percent-escape, no separator.
fn plain(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && segment != "."
        && segment != ".."
        && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
}

fn visible(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_graphic())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(operations: &[(&str, &str)]) -> Result<Arc<Host>, ApiError> {
        let operations = operations
            .iter()
            .map(|(method, path)| Operation { name: "op".into(), method: (*method).into(), path: (*path).into() })
            .collect();
        Host::new(Registration { port: 1, secret: None, operations })
    }

    #[test]
    fn only_what_is_registered_matches() {
        let host = host(&[("POST", "/v1/chat/completions"), ("GET", "/v1/artifacts/:id")]).ok().unwrap();
        assert!(host.operation("POST", "/v1/chat/completions").is_some());
        assert!(host.operation("POST", "/v1/chat/completions?stream=true").is_some());
        assert!(host.operation("GET", "/v1/artifacts/a1b2-c3.png").is_some());

        assert!(host.operation("GET", "/v1/chat/completions").is_none());
        assert!(host.operation("POST", "/v1/chat").is_none());
        assert!(host.operation("POST", "/v1/chat/completions/extra").is_none());
        assert!(host.operation("POST", "/v1/chat/completions/").is_none());
        assert!(host.operation("POST", "v1/chat/completions").is_none());
        assert!(host.operation("GET", "/v1/artifacts/").is_none());
        assert!(host.operation("GET", "/v1/artifacts/..").is_none());
        assert!(host.operation("GET", "/v1/artifacts/a/b").is_none());
        assert!(host.operation("GET", "/v1/artifacts/a%2Fb").is_none());
        assert!(host.operation("GET", "/v1/artifacts/a b").is_none());
        assert!(host.operation("GET", "/v1/artifacts/a?x=\r\nhost: elsewhere").is_none());
        assert!(host.operation("GET", &format!("/v1/artifacts/a?{}", "x".repeat(PATH_MAX))).is_none());
    }

    #[test]
    fn a_registration_that_could_reach_further_is_refused() {
        assert!(host(&[("POST", "/v1/jobs")]).is_ok());
        assert!(host(&[("POST", "v1/jobs")]).is_err());
        assert!(host(&[("POST", "/")]).is_err());
        assert!(host(&[("POST", "/v1//jobs")]).is_err());
        assert!(host(&[("POST", "/v1/../jobs")]).is_err());
        assert!(host(&[("POST", "/v1/*")]).is_err());
        assert!(host(&[("POST", "/v1/jobs?x=1")]).is_err());
        assert!(host(&[("CONNECT", "/v1/jobs")]).is_err());
        assert!(Host::new(Registration { port: 0, secret: None, operations: vec![] }).is_err());
    }
}
