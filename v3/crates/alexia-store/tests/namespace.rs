// SPDX-License-Identifier: AGPL-3.0-only
use alexia_store::*;
use serde_json::{json, Value};

fn store(ns: &str, tables: &[&str]) -> Store {
    let s = Store::open_in_memory().unwrap();
    let t: Vec<String> = tables.iter().map(|t| t.to_string()).collect();
    s.create_tables(ns, &t).unwrap();
    s
}

fn row(v: Value) -> Row {
    v.as_object().unwrap().clone()
}

fn filter(v: Value) -> Where {
    serde_json::from_value(v).unwrap()
}

fn tables(s: &Store) -> Vec<String> {
    s.transaction(|tx| {
        let mut st =
            tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?;
        let names = st.query_map([], |r| r.get(0))?;
        Ok(names.collect::<rusqlite::Result<_>>()?)
    })
    .unwrap()
}

fn column_types(s: &Store, table: &str) -> Vec<(String, String)> {
    s.transaction(|tx| {
        let mut st = tx.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
        let cols = st.query_map([], |r| Ok((r.get(1)?, r.get(2)?)))?;
        Ok(cols.collect::<rusqlite::Result<_>>()?)
    })
    .unwrap()
}

/// Five rows: n = 1..=5, t = "a".."e", z null on even n.
fn numbers() -> Store {
    let s = store("demo", &["t"]);
    for (n, t) in (1..=5).zip(["a", "b", "c", "d", "e"]) {
        let z = if n % 2 == 0 {
            Value::Null
        } else {
            json!(n * 10)
        };
        s.insert("demo", "t", &row(json!({"n": n, "t": t, "z": z})))
            .unwrap();
    }
    s
}

fn ns_of(s: &Store, w: Value) -> Vec<i64> {
    let q = Select {
        filter: Some(filter(w)),
        order: vec![("n".into(), Dir::Asc)],
        ..Select::default()
    };
    s.select("demo", "t", &q)
        .unwrap()
        .iter()
        .map(|r| r["n"].as_i64().unwrap())
        .collect()
}

#[test]
fn insert_grows_columns_with_v2_types() {
    let s = store("demo", &["t"]);
    let id = s
        .insert(
            "demo",
            "t",
            &row(json!({"text":"a","n":3,"x":1.5,"b":true,"o":{"k":1},"z":null})),
        )
        .unwrap();
    assert_eq!(id, 1);
    let types = column_types(&s, "p_demo_t");
    let ty = |c: &str| types.iter().find(|(n, _)| n == c).unwrap().1.clone();
    assert_eq!(ty("n"), "INTEGER");
    assert_eq!(ty("b"), "INTEGER");
    assert_eq!(ty("x"), "REAL");
    assert_eq!(ty("text"), "TEXT");
    assert_eq!(ty("o"), "TEXT");
    assert_eq!(ty("z"), "TEXT");
    let rows = s.select("demo", "t", &Select::default()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["rowid"], json!(1));
    assert_eq!(rows[0]["b"], json!(1));
    assert_eq!(rows[0]["o"], json!({"k": 1}));
    assert_eq!(rows[0]["x"], json!(1.5));
    assert_eq!(rows[0]["text"], json!("a"));
    assert_eq!(rows[0]["z"], Value::Null);
    // A rowid key is core's, not the plugin's.
    assert!(matches!(
        s.insert("demo", "t", &row(json!({"rowid": 9}))),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn where_grammar() {
    let s = numbers();
    assert_eq!(ns_of(&s, json!({"n": {"eq": 2}})), [2]);
    assert_eq!(ns_of(&s, json!({"t": "c"})), [3]);
    assert_eq!(ns_of(&s, json!({"n": {"ne": 2}})), [1, 3, 4, 5]);
    assert_eq!(ns_of(&s, json!({"n": {"lt": 3}})), [1, 2]);
    assert_eq!(ns_of(&s, json!({"n": {"lte": 3}})), [1, 2, 3]);
    assert_eq!(ns_of(&s, json!({"n": {"gt": 3}})), [4, 5]);
    assert_eq!(ns_of(&s, json!({"n": {"gte": 3}})), [3, 4, 5]);
    assert_eq!(ns_of(&s, json!({"t": {"in": ["a", "e", "q"]}})), [1, 5]);
    assert_eq!(ns_of(&s, json!({"t": {"like": "%d%"}})), [4]);
    assert_eq!(ns_of(&s, json!({"z": {"isNull": true}})), [2, 4]);
    assert_eq!(
        ns_of(&s, json!({"n": {"gte": 2}, "z": {"isNull": true}})),
        [2, 4]
    );
    assert_eq!(
        s.count("demo", "t", Some(&filter(json!({"n": {"gt": 1}}))))
            .unwrap(),
        4
    );
    assert_eq!(s.count("demo", "t", None).unwrap(), 5);
    // Two operators in one condition, and an unknown column, are malformed.
    let bad = Select {
        filter: Some(filter(json!({"n": {"lt": 3, "gt": 1}}))),
        ..Select::default()
    };
    assert!(matches!(
        s.select("demo", "t", &bad),
        Err(Error::Invalid(_))
    ));
    let bad = Select {
        filter: Some(filter(json!({"nope": 1}))),
        ..Select::default()
    };
    assert!(matches!(
        s.select("demo", "t", &bad),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn order_limit_offset() {
    let s = numbers();
    let q = Select {
        order: vec![("n".into(), Dir::Desc)],
        limit: Some(2),
        offset: Some(1),
        ..Select::default()
    };
    let got: Vec<i64> = s
        .select("demo", "t", &q)
        .unwrap()
        .iter()
        .map(|r| r["n"].as_i64().unwrap())
        .collect();
    assert_eq!(got, [4, 3]);
    let q = Select {
        order: vec![("n".into(), Dir::Asc)],
        offset: Some(3),
        ..Select::default()
    };
    assert_eq!(s.select("demo", "t", &q).unwrap().len(), 2);
}

#[test]
fn update_and_delete_need_where() {
    let s = numbers();
    let empty = Where::new();
    assert!(matches!(
        s.update("demo", "t", &row(json!({"t": "x"})), &empty),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        s.delete("demo", "t", DeleteScope::Where(&empty)),
        Err(Error::Invalid(_))
    ));
    // A new key in set grows a column.
    let changed = s
        .update(
            "demo",
            "t",
            &row(json!({"t": "x", "seen": true})),
            &filter(json!({"n": {"lte": 2}})),
        )
        .unwrap();
    assert_eq!(changed, 2);
    assert_eq!(ns_of(&s, json!({"t": "x", "seen": 1})), [1, 2]);
    assert_eq!(
        s.delete("demo", "t", DeleteScope::Where(&filter(json!({"n": 5}))))
            .unwrap(),
        1
    );
    assert_eq!(s.delete("demo", "t", DeleteScope::All).unwrap(), 4);
    assert_eq!(s.count("demo", "t", None).unwrap(), 0);
}

#[test]
fn undeclared_table_is_out_of_namespace() {
    let s = store("demo", &["t"]);
    let err = s
        .insert("demo", "other", &row(json!({"a": 1})))
        .unwrap_err();
    assert!(matches!(err, Error::OutOfNamespace(_)));
    assert_eq!(err.to_string(), "other is not one of this plugin's tables.");
    // Another plugin's declared table is not yours either.
    s.create_tables("rival", &["t".into()]).unwrap();
    s.insert("rival", "t", &row(json!({"a": 1}))).unwrap();
    assert!(matches!(
        s.select("intruder", "t", &Select::default()),
        Err(Error::OutOfNamespace(_))
    ));
    assert!(!tables(&s).contains(&"p_demo_other".to_string()));
}

#[test]
fn injection_is_refused() {
    let s = numbers();
    assert!(s
        .create_tables("demo", &["x; DROP TABLE kv".into()])
        .is_err());
    assert!(s
        .insert("demo", "x; DROP TABLE kv", &row(json!({"a": 1})))
        .is_err());
    assert!(matches!(
        s.insert("demo", "t", &row(json!({"a\"b": 1}))),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        s.create_tables("A", &["t".into()]),
        Err(Error::Invalid(_))
    ));
    assert!(ns_of(&s, json!({"t": {"like": "%' OR 1=1 --"}})).is_empty());
    assert!(ns_of(&s, json!({"t": "' OR 1=1 --"})).is_empty());
    assert!(tables(&s).contains(&"kv".to_string()));
    assert_eq!(s.count("demo", "t", None).unwrap(), 5);
}

#[test]
fn hyphenated_namespace() {
    let s = store("web-research", &["pages"]);
    s.insert("web-research", "pages", &row(json!({"url": "u"})))
        .unwrap();
    assert!(tables(&s).contains(&"p_web_research_pages".to_string()));
    assert_eq!(s.count("web-research", "pages", None).unwrap(), 1);
}

#[test]
fn raw_is_refused() {
    let s = store("demo", &["t"]);
    let err = s.raw("demo", "SELECT 1", &[]).unwrap_err();
    assert!(matches!(err, Error::OutOfNamespace(_)));
    assert!(matches!(
        s.raw("demo", "SELECT * FROM t WHERE a = ?", &[Scalar::Bool(true)]),
        Err(Error::OutOfNamespace(_))
    ));
}

#[test]
fn purge_removes_tables_kv_settings() {
    let s = Store::open_in_memory().unwrap();
    for p in ["one", "two"] {
        s.create_tables(p, &["a".into(), "b".into()]).unwrap();
        s.insert(p, "a", &row(json!({"v": 1}))).unwrap();
        s.kv_set(p, "k", &json!(1)).unwrap();
        s.set_setting(p, "s", &json!("x")).unwrap();
    }
    s.purge("one", Some("one")).unwrap();
    let t = tables(&s);
    assert!(!t.iter().any(|n| n.starts_with("p_one_")));
    assert!(t.contains(&"p_two_a".to_string()) && t.contains(&"p_two_b".to_string()));
    assert_eq!(s.kv_get("one", "k").unwrap(), None);
    assert!(s.settings("one").unwrap().is_empty());
    assert_eq!(s.kv_get("_core", "tables:one").unwrap(), None);
    assert!(matches!(
        s.insert("one", "a", &row(json!({"v": 1}))),
        Err(Error::OutOfNamespace(_))
    ));
    assert_eq!(s.kv_get("two", "k").unwrap(), Some(json!(1)));
    assert_eq!(s.settings("two").unwrap()["s"], json!("x"));
    assert_eq!(
        s.kv_get("_core", "tables:two").unwrap(),
        Some(json!(["a", "b"]))
    );
    assert_eq!(s.count("two", "a", None).unwrap(), 1);
}

#[test]
fn purge_does_not_cross_namespaces() {
    let s = Store::open_in_memory().unwrap();
    s.create_tables("a", &["b_x".into()]).unwrap();
    s.create_tables("a-b", &["y".into(), "y".into()]).unwrap();
    assert_eq!(s.kv_get("_core", "tables:a-b").unwrap(), Some(json!(["y"])));
    s.insert("a", "b_x", &row(json!({"v": 1}))).unwrap();
    s.purge("a-b", Some("a-b")).unwrap();
    let t = tables(&s);
    assert!(t.contains(&"p_a_b_x".to_string()));
    assert!(!t.contains(&"p_a_b_y".to_string()));
    assert_eq!(s.count("a", "b_x", None).unwrap(), 1);
}
