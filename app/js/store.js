// Small localStorage wrapper. Everything stays on the device.
const K = {
  lang: 'chajra.lang',
  apiKey: 'chajra.apiKey',
  model: 'chajra.model',
  models: 'chajra.models',
  history: 'chajra.history'
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const store = {
  lang:      () => read(K.lang, null),
  setLang:   v  => write(K.lang, v),

  apiKey:    () => read(K.apiKey, ''),
  setApiKey: v  => write(K.apiKey, (v || '').trim()),

  model:     () => read(K.model, ''),
  setModel:  v  => write(K.model, v),

  models:    () => read(K.models, []),
  setModels: v  => write(K.models, v),

  history:   () => read(K.history, []),
  addHistory(entry) {
    const h = read(K.history, []);
    h.unshift(entry);
    // Thumbnails are the bulk of the payload; trim rather than blow the quota.
    while (h.length > 40) h.pop();
    while (!write(K.history, h) && h.length > 1) h.pop();
    return h;
  },
  clearHistory: () => write(K.history, [])
};
