// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
// Small DOM toolkit: element builder, modal dialogs, context menus, toasts, data-bound forms.

export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- modal dialogs --------------------------------------------------------
let dialogDepth = 0;
export const isDialogOpen = () => dialogDepth > 0;

/**
 * Show a modal. Resolves with the clicked button's value (null on Escape/close).
 * buttons: [{ label, value, primary, danger, validate?: () => string|null }]
 */
export function showDialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width = 480, className = '', onOpen }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    dialogDepth++;
    const close = (value) => {
      dialogDepth--;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    };
    const footer = h('div.modal-footer', {},
      buttons.map((b) => h('button', {
        class: b.primary ? 'primary' : b.danger ? 'danger' : '',
        onclick: () => {
          if (b.validate) { const err = b.validate(); if (err) return toast(err, 'error'); }
          close(b.value);
        },
      }, b.label)));
    const modal = h('div.modal', { class: className, style: { width: typeof width === 'number' ? width + 'px' : width }, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div.modal-header', {}, h('span', {}, title), h('button.icon-btn', { title: 'Close', 'aria-label': 'Close', onclick: () => close(null) }, '✕')),
      h('div.modal-body', {}, body),
      footer);
    const backdrop = h('div.modal-backdrop', {}, modal);
    const onKey = (e) => {
      if (backdrop !== $$('.modal-backdrop').pop()) return; // only the topmost dialog handles keys
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          footer.children[buttons.indexOf(primary)].click();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    const first = modal.querySelector('[autofocus], input:not([type=checkbox]):not([disabled]), select, textarea');
    (first || footer.querySelector('.primary') || footer.lastChild)?.focus();
    onOpen?.(modal, close);
  });
}

export async function alertDialog(title, message) {
  await showDialog({ title, body: h('p.pre', {}, message), buttons: [{ label: 'OK', value: true, primary: true }] });
}

export async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return !!(await showDialog({
    title, body: h('p.pre', {}, message),
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  }));
}

export async function promptDialog(title, message, defaultValue = '', password = false) {
  const input = h('input', { type: password ? 'password' : 'text', value: defaultValue, autofocus: true });
  const ok = await showDialog({
    title, body: h('div.form', {}, message ? h('label.block', {}, message) : null, input),
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
  });
  return ok ? input.value : null;
}

// ---- context menu ---------------------------------------------------------
let openMenu = null;
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div.context-menu', { role: 'menu' },
    items.filter(Boolean).map((it) => it === '-'
      ? h('div.sep')
      : h('div.item', {
        class: it.disabled ? 'disabled' : '', role: 'menuitem',
        onclick: () => { if (it.disabled) return; closeContextMenu(); it.action(); },
      }, h('span', {}, it.label), it.hint ? h('span.hint', {}, it.hint) : null)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true));
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeContextMenu(); }
export function closeContextMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
}
if (typeof document !== 'undefined') document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

// ---- toast ------------------------------------------------------------------
export function toast(message, kind = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const t = h('div.toast', { class: kind, role: 'status' }, message);
  host.append(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---- data-bound forms -------------------------------------------------------
export function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function setPath(obj, p, v) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[keys.at(-1)] = v;
}

/** Fill every [data-path] control under root from obj. */
export function fillForm(root, obj) {
  for (const el of $$('[data-path]', root)) {
    const v = getPath(obj, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (v != null) el.value = v;
  }
}

/** Write every [data-path] control under root back into obj. */
export function collectForm(root, obj) {
  for (const el of $$('[data-path]', root)) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = el.value === '' ? 0 : Number(el.value);
    setPath(obj, el.dataset.path, v);
  }
  return obj;
}

/** Labeled form row. */
export function field(label, control, hint) {
  return h('label.field', {}, h('span.label', {}, label), control, hint ? h('span.hint', {}, hint) : null);
}

export function input(path, attrs = {}) { return h('input', { type: 'text', dataset: { path }, ...attrs }); }
export function number(path, attrs = {}) { return h('input', { type: 'number', dataset: { path }, ...attrs }); }
export function checkbox(path, label, attrs = {}) {
  return h('label.check', {}, h('input', { type: 'checkbox', dataset: { path }, ...attrs }), h('span', {}, label));
}
export function select(path, options, attrs = {}) {
  return h('select', { dataset: { path }, ...attrs },
    options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
}

/** Simple editable table for lists of objects (forwards, logon actions, buttons...). */
export function listEditor({ items, columns, newItem, onChange }) {
  const wrap = h('div.list-editor');
  const render = () => {
    wrap.replaceChildren(
      h('div.table-scroll', {},
        h('table', {},
          h('thead', {}, h('tr', {}, columns.map((c) => h('th', { style: { width: c.width || '' } }, c.label)), h('th', { style: { width: '72px' } }))),
          h('tbody', {}, items.map((it, i) => h('tr', {},
            columns.map((c) => h('td', {}, cellControl(c, it, onChange))),
            h('td.row-actions', {},
              h('button.icon-btn', { title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; render(); onChange?.(); } }, '↑'),
              h('button.icon-btn', { title: 'Remove', 'aria-label': 'Remove', onclick: () => { items.splice(i, 1); render(); onChange?.(); } }, '✕'))))),
        )),
      h('button.small', { onclick: () => { items.push(newItem()); render(); onChange?.(); } }, '+ Add'));
  };
  render();
  return wrap;
}

function cellControl(c, it, onChange) {
  const set = (v) => { it[c.key] = v; onChange?.(); };
  if (c.type === 'checkbox') return h('input', { type: 'checkbox', checked: !!it[c.key], onchange: (e) => set(e.target.checked), 'aria-label': c.label });
  if (c.type === 'select') {
    const s = h('select', { onchange: (e) => set(e.target.value), 'aria-label': c.label },
      c.options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
    s.value = it[c.key] ?? c.options[0]?.[0] ?? c.options[0];
    return s;
  }
  if (c.type === 'color') return h('input', { type: 'color', value: it[c.key] || '#ffffff', oninput: (e) => set(e.target.value), 'aria-label': c.label });
  return h('input', {
    type: c.type || 'text', value: it[c.key] ?? '', placeholder: c.placeholder || '', 'aria-label': c.label,
    oninput: (e) => set(c.type === 'number' ? Number(e.target.value) : e.target.value),
  });
}
