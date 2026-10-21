// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Helpers for reading loosely-typed JSON (sessions, settings, renderer arguments) with the same
//! coercions the page uses: a missing or wrong-typed value reads as empty / zero / false.

use serde_json::{Map, Value};

/// The value at `path` (object keys), or Null.
pub fn at<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
    let mut cur = v;
    for k in path {
        match cur.get(k) {
            Some(x) => cur = x,
            None => return &Value::Null,
        }
    }
    cur
}

/// JavaScript truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(x || '')`.
pub fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f == 0.0 { String::new() } else { num_to_string(f) }
        }
        Value::Bool(true) => "true".into(),
        _ => String::new(),
    }
}

pub fn str_at(v: &Value, path: &[&str]) -> String {
    string(at(v, path))
}

/// `Number(x)` (NaN as None).
pub fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() }
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// `Number(x) || fallback`.
pub fn num_or(v: &Value, fallback: f64) -> f64 {
    match number(v) {
        Some(f) if f != 0.0 && !f.is_nan() => f,
        _ => fallback,
    }
}

pub fn num_at(v: &Value, path: &[&str], fallback: f64) -> f64 {
    num_or(at(v, path), fallback)
}

pub fn bool_at(v: &Value, path: &[&str]) -> bool {
    truthy(at(v, path))
}

/// `x !== false` (unset counts as true).
pub fn not_false(v: &Value, path: &[&str]) -> bool {
    !matches!(at(v, path), Value::Bool(false))
}

pub fn num_to_string(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", f as i64) } else { format!("{f}") }
}

/// Mutable object at `key` inside `v`, creating it (and turning `v` into an object) when needed.
pub fn obj_mut<'a>(v: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !v.is_object() {
        *v = Value::Object(Map::new());
    }
    let m = v.as_object_mut().unwrap();
    let entry = m.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().unwrap()
}

pub fn set(v: &mut Value, key: &str, val: Value) {
    if !v.is_object() {
        *v = Value::Object(Map::new());
    }
    v.as_object_mut().unwrap().insert(key.to_string(), val);
}

pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map(|a| a.as_slice()).unwrap_or(&[])
}

/// An argument from the page as a string (`String(x)`), '' for null/undefined.
pub fn arg_str(args: &[Value], i: usize) -> String {
    match args.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => num_to_string(n.as_f64().unwrap_or(0.0)),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

pub fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}
