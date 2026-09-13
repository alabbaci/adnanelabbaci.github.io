// Timed, narrated step-by-step player.
//
// Not a video file: a sequence of timed steps drawn over the farmer's own
// photo, with a segmented timeline and speech narration. It plays like a clip,
// it weighs nothing, and it works offline — which a hosted video would not.
import { t, tx, getLang, locale } from './i18n.js';

export class GuidePlayer {
  constructor(root) {
    this.root = root;
    this.steps = [];
    this.index = 0;
    this.timer = null;
    this.playing = false;
    this.speak = true;
  }

  load(steps, backdrop) {
    this.stop();
    this.steps = steps || [];
    this.index = 0;
    this.backdrop = backdrop || '';
    this.render();
  }

  render() {
    if (!this.steps.length) { this.root.innerHTML = ''; return; }
    const total = this.steps.reduce((a, s) => a + (s.s || 8), 0);

    this.root.innerHTML = `
      <div class="guide">
        <div class="guide-stage">
          ${this.backdrop ? `<img src="${this.backdrop}" alt="" class="guide-bg">` : '<div class="guide-bg guide-bg-empty"></div>'}
          <div class="guide-caption">
            <span class="guide-step-no"></span>
            <p class="guide-text"></p>
          </div>
        </div>
        <div class="guide-timeline" role="group" aria-label="${t('guide_title')}">
          ${this.steps.map((s, i) =>
            `<button class="guide-seg" data-i="${i}" style="flex:${s.s || 8}" aria-label="${i + 1}"><span></span></button>`
          ).join('')}
        </div>
        <div class="guide-controls">
          <button class="btn btn-primary guide-play"></button>
          <button class="btn guide-speak" aria-pressed="true">${t('speak')}</button>
          <span class="guide-time muted">0:00 / ${fmt(total)}</span>
        </div>
      </div>`;

    this.el = {
      no: this.root.querySelector('.guide-step-no'),
      text: this.root.querySelector('.guide-text'),
      play: this.root.querySelector('.guide-play'),
      speakBtn: this.root.querySelector('.guide-speak'),
      time: this.root.querySelector('.guide-time'),
      segs: [...this.root.querySelectorAll('.guide-seg')],
      bg: this.root.querySelector('.guide-bg')
    };
    this.total = total;

    this.el.play.addEventListener('click', () => this.playing ? this.pause() : this.play());
    this.el.speakBtn.addEventListener('click', () => {
      this.speak = !this.speak;
      this.el.speakBtn.setAttribute('aria-pressed', String(this.speak));
      this.el.speakBtn.textContent = this.speak ? t('speak') : t('stop_speak');
      if (!this.speak) cancelSpeech();
    });
    this.el.segs.forEach(seg => seg.addEventListener('click', () => {
      this.goto(Number(seg.dataset.i));
      if (!this.playing) this.show();
    }));

    this.show();
    this.updatePlayLabel();
  }

  show() {
    const step = this.steps[this.index];
    if (!step) return;
    this.el.no.textContent = `${this.index + 1} / ${this.steps.length}`;
    this.el.text.textContent = tx(step);
    this.el.segs.forEach((s, i) => s.classList.toggle('done', i < this.index));
    this.el.segs.forEach((s, i) => s.classList.toggle('active', i === this.index));
    const elapsed = this.steps.slice(0, this.index).reduce((a, s) => a + (s.s || 8), 0);
    this.el.time.textContent = `${fmt(elapsed)} / ${fmt(this.total)}`;
    if (this.el.bg) this.el.bg.classList.toggle('panning', this.playing);
  }

  play() {
    if (!this.steps.length) return;
    this.playing = true;
    this.updatePlayLabel();
    this.tick();
  }

  tick() {
    this.show();
    const step = this.steps[this.index];
    if (this.speak) say(tx(step));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.index < this.steps.length - 1) { this.index++; this.tick(); }
      else { this.pause(); }
    }, (step.s || 8) * 1000);
  }

  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    cancelSpeech();
    this.updatePlayLabel();
    if (this.el && this.el.bg) this.el.bg.classList.remove('panning');
  }

  stop() { this.pause(); this.index = 0; }

  goto(i) {
    this.index = Math.max(0, Math.min(i, this.steps.length - 1));
    if (this.playing) this.tick(); else this.show();
  }

  updatePlayLabel() {
    if (this.el) this.el.play.textContent = this.playing ? `⏸ ${t('pause')}` : `▶ ${t('play')}`;
  }
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function say(text) {
  if (!('speechSynthesis' in window) || !text) return;
  cancelSpeech();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = locale();
  u.rate = getLang() === 'ar' ? 0.9 : 1;
  const voice = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith(getLang()));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export function cancelSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
