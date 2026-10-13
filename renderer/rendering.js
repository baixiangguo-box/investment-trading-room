const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const nonEditors = new Set(['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit']);

function key(node) {
  if (node.nodeType !== ELEMENT) return null;
  const id = node.getAttribute('id');
  if (id) return `id:${id}`;
  const input = node.getAttribute('data-input');
  if (input) return `input:${input}`;
  const action = node.getAttribute('data-action');
  if (action) {
    const identity = ['data-symbol', 'data-id', 'data-generation', 'data-side', 'data-kind', 'data-market', 'data-tab', 'data-page', 'data-sort']
      .map(attribute => `${attribute}:${node.getAttribute(attribute) || ''}`).join('|');
    const stableAction = ['watch-add', 'watch-remove'].includes(action) ? 'watch-toggle' : action;
    return `action:${stableAction}|${identity}`;
  }
  return null;
}

function compatible(current, desired) {
  if (current.nodeType !== desired.nodeType) return false;
  if (current.nodeType !== ELEMENT) return true;
  if (current.namespaceURI !== desired.namespaceURI || current.localName !== desired.localName || key(current) !== key(desired)) return false;
  return current.localName !== 'input' || current.type === desired.type;
}

function editable(node) {
  if (!node || node.nodeType !== ELEMENT) return false;
  return node.localName === 'textarea' || (node.localName === 'input' && !nonEditors.has(node.type)) || node.isContentEditable;
}

function editorKeys(node, cache) {
  if (cache.has(node)) return cache.get(node);
  const keys = new Set();
  if (node.nodeType === ELEMENT) {
    if (['input', 'textarea', 'select', 'button', 'a', 'tr'].includes(node.localName) || node.hasAttribute('contenteditable')) {
      const ownKey = key(node);
      if (ownKey) keys.add(ownKey);
    }
    for (const child of node.children) for (const childKey of editorKeys(child, cache)) keys.add(childKey);
  }
  cache.set(node, keys);
  return keys;
}

function updateAttributes(current, desired, preserveValue) {
  for (const attribute of Array.from(current.attributes)) {
    if (preserveValue && attribute.name === 'value') continue;
    if (!desired.hasAttributeNS(attribute.namespaceURI, attribute.localName)) current.removeAttributeNS(attribute.namespaceURI, attribute.localName);
  }
  for (const attribute of desired.attributes) {
    if (preserveValue && attribute.name === 'value') continue;
    if (current.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value) current.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
}

function updateControl(current, desired, preserveValue) {
  if (current.localName === 'input') {
    if (!preserveValue && current.type !== 'file' && current.value !== desired.value) current.value = desired.value;
    if (current.checked !== desired.checked) current.checked = desired.checked;
    if (current.indeterminate !== desired.indeterminate) current.indeterminate = desired.indeterminate;
  } else if (current.localName === 'textarea') {
    if (!preserveValue && current.value !== desired.value) current.value = desired.value;
  } else if (current.localName === 'option') {
    if (current.selected !== desired.selected) current.selected = desired.selected;
  } else if (current.localName === 'select') {
    // Option selection is a property too: changing/removing its attribute alone
    // does not reset a select that the user has already changed.
    for (let index = 0; index < current.options.length; index++) {
      const selected = desired.options[index]?.selected ?? false;
      if (current.options[index].selected !== selected) current.options[index].selected = selected;
    }
    if (!current.multiple && current.selectedIndex !== desired.selectedIndex) current.selectedIndex = desired.selectedIndex;
  }
}

function patchNode(current, desired, context) {
  if (current.nodeType === TEXT || current.nodeType === COMMENT) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  if (current.nodeType !== ELEMENT) return;
  const preserveValue = current === context.active && editable(current);
  updateAttributes(current, desired, preserveValue);
  // Both a textarea's text and an editable subtree can modify the active
  // editor's live value/selection even without assigning its value property.
  if (!(preserveValue && (current.localName === 'textarea' || current.isContentEditable))) patchChildren(current, desired, context);
  updateControl(current, desired, preserveValue);
}

function patchChildren(parent, desiredParent, context) {
  const previous = Array.from(parent.childNodes);
  const used = new Set();
  const keyed = new Map();
  for (const node of previous) {
    const identity = key(node);
    if (identity && !keyed.has(identity)) keyed.set(identity, node);
  }
  const activeBranch = previous.find(node => node === context.active || node.contains(context.active));
  const target = [];
  let position = 0;
  for (const desired of Array.from(desiredParent.childNodes)) {
    const identity = key(desired), desiredEditors = editorKeys(desired, context.desiredKeys);
    let current = identity ? keyed.get(identity) : null;
    if (current && (used.has(current) || !compatible(current, desired))) current = null;
    if (!identity) {
      // Keep wrappers around the same keyed editor when a status message or
      // another conditional sibling is inserted before the wrapper.
      let score = 0;
      if (desiredEditors.size) {
        for (const candidate of previous) {
          if (used.has(candidate) || !compatible(candidate, desired)) continue;
          const candidateEditors = editorKeys(candidate, context.previousKeys);
          let intersection = 0;
          for (const editor of desiredEditors) if (candidateEditors.has(editor)) intersection++;
          if (intersection && candidate === activeBranch) intersection += desiredEditors.size + candidateEditors.size;
          if (intersection > score) { current = candidate; score = intersection; }
        }
      }
      if (!current) {
        while (position < previous.length && used.has(previous[position])) position++;
        for (let index = position; index < previous.length; index++) {
          const candidate = previous[index];
          if (used.has(candidate) || !compatible(candidate, desired)) continue;
          // Do not consume an editor-bearing wrapper for an unrelated message.
          if (editorKeys(candidate, context.previousKeys).size) continue;
          current = candidate;
          break;
        }
      }
    }
    if (current) {
      used.add(current);
      patchNode(current, desired, context);
      target.push(current);
    } else target.push(desired.cloneNode(true));
  }
  for (const node of previous) if (!used.has(node)) node.remove();

  const anchor = target.indexOf(activeBranch);
  if (anchor !== -1) {
    // Reorder siblings around the focused branch. Moving the focused node or
    // an ancestor with insertBefore would briefly detach it and lose focus.
    let reference = activeBranch;
    for (let index = anchor - 1; index >= 0; index--) {
      const node = target[index];
      if (node.nextSibling !== reference) parent.insertBefore(node, reference);
      reference = node;
    }
    reference = activeBranch;
    for (let index = anchor + 1; index < target.length; index++) {
      const node = target[index];
      if (node.previousSibling !== reference) parent.insertBefore(node, reference.nextSibling);
      reference = node;
    }
  } else {
    let reference = parent.firstChild;
    for (const node of target) {
      if (node !== reference) parent.insertBefore(node, reference);
      reference = node.nextSibling;
    }
  }
}

/** Update one page without replacing compatible existing DOM or active editors.
 * The caller owns page changes and composition boundaries; HTML must already
 * have escaped untrusted values, just as for the previous innerHTML renderer.
 */
export function reconcileContent(container, html) {
  const document = container.ownerDocument;
  const template = document.createElement('template');
  template.innerHTML = html;
  patchChildren(container, template.content, {
    active: document.activeElement,
    previousKeys: new WeakMap(),
    desiredKeys: new WeakMap(),
  });
  return container;
}
