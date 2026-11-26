// 极简 hyperscript：h('div.cls', {onClick}, children...)
export type Child = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v as Record<string, string>);
      } else if (k in el && k !== 'list') {
        try {
          (el as unknown as Record<string, unknown>)[k] = v;
        } catch {
          el.setAttribute(k, String(v));
        }
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === false || c == null) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.innerHTML = '';
}

export function mount(el: HTMLElement, children: Child[]): void {
  clear(el);
  for (const c of children.flat()) {
    if (c === false || c == null) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}
