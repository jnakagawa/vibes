// ui.js — DOM overlay: HUD, cards, toolbar, settings panel, toasts.

export class UI {
  constructor() {
    this.el = {};
    for (const id of [
      'landing', 'loader', 'loader-step', 'endcard', 'end-emoji', 'end-verdict',
      'end-sub', 'toolbar', 'panel', 'phrase', 'petals-left', 'toasts',
      'dropzone', 'camwrap', 'file-input',
    ]) {
      this.el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
    }
  }

  showLanding() { this.el.landing.hidden = false; }
  hideLanding() { this.el.landing.hidden = true; }

  showLoader(step) { this.el.loader.hidden = false; this.setLoaderStep(step); }
  setLoaderStep(txt) { this.el.loaderStep.textContent = txt; }
  hideLoader() { this.el.loader.hidden = true; }

  setPhrase(text, pop = false) {
    const p = this.el.phrase;
    p.textContent = text;
    p.classList.add('show');
    if (pop) {
      p.classList.remove('pop');
      void p.offsetWidth;              // restart the animation
      p.classList.add('pop');
    }
  }

  setPetalsLeft(n) {
    this.el.petalsLeft.textContent = n > 0 ? `🌼 ${n} petal${n === 1 ? '' : 's'} left` : '';
  }

  showEnd(verdict, sub, emoji) {
    this.el.endEmoji.textContent = emoji;
    this.el.endVerdict.textContent = verdict;
    this.el.endSub.textContent = sub;
    this.el.endcard.hidden = false;
  }
  hideEnd() { this.el.endcard.hidden = true; }

  showToolbar() { this.el.toolbar.hidden = false; }

  togglePanel() { this.el.panel.hidden = !this.el.panel.hidden; }

  toast(msg, ms = 3200) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    this.el.toasts.appendChild(div);
    setTimeout(() => {
      div.classList.add('out');
      setTimeout(() => div.remove(), 500);
    }, ms);
  }

  // controls: [{ type:'range'|'check', key, label, min, max, step, value, fmt, onChange }]
  buildPanel(controls) {
    const panel = this.el.panel;
    panel.innerHTML = '';
    for (const c of controls) {
      const wrap = document.createElement('div');
      wrap.className = 'ctl';
      if (c.type === 'range') {
        const label = document.createElement('label');
        const name = document.createElement('span');
        name.textContent = c.label;
        const val = document.createElement('span');
        val.className = 'val';
        const fmt = c.fmt || (v => v);
        val.textContent = fmt(c.value);
        label.append(name, val);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = c.min; input.max = c.max; input.step = c.step;
        input.value = c.value;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          val.textContent = fmt(v);
          c.onChange(v);
        });
        wrap.append(label, input);
      } else {
        const label = document.createElement('label');
        label.className = 'toggle';
        const name = document.createElement('span');
        name.textContent = c.label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = c.value;
        input.addEventListener('change', () => c.onChange(input.checked));
        label.append(name, input);
        wrap.append(label);
      }
      panel.appendChild(wrap);
    }
  }
}
