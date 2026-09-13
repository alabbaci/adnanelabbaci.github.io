// Trilingual strings. Arabic drives RTL layout via <html dir>.
export const LANGS = {
  fr: { label: 'Français', dir: 'ltr', locale: 'fr-MA' },
  ar: { label: 'العربية', dir: 'rtl', locale: 'ar-MA' },
  en: { label: 'English', dir: 'ltr', locale: 'en-GB' }
};

const S = {
  app_name:        { fr: 'Chajra', ar: 'شجرة', en: 'Chajra' },
  tagline:         { fr: 'Diagnostic des arbres fruitiers', ar: 'تشخيص الأشجار المثمرة', en: 'Fruit tree diagnosis' },

  nav_diagnose:    { fr: 'Diagnostic', ar: 'تشخيص', en: 'Diagnose' },
  nav_library:     { fr: 'Fiches', ar: 'البطاقات', en: 'Library' },
  nav_history:     { fr: 'Historique', ar: 'السجل', en: 'History' },
  nav_settings:    { fr: 'Réglages', ar: 'الإعدادات', en: 'Settings' },

  step_crop:       { fr: 'Quelle culture ?', ar: 'أي زراعة؟', en: 'Which crop?' },
  step_capture:    { fr: 'Photographiez le problème', ar: 'صوّر المشكل', en: 'Photograph the problem' },
  step_context:    { fr: 'Un peu de contexte', ar: 'بعض السياق', en: 'A little context' },
  step_result:     { fr: 'Résultat', ar: 'النتيجة', en: 'Result' },

  capture_hint:    { fr: 'Prenez 1 à 4 photos : l’organe atteint de près, puis l’arbre entier. Ajoutez une vidéo si le problème touche tout l’arbre.', ar: 'التقط من 1 إلى 4 صور: العضو المصاب عن قرب ثم الشجرة كاملة. أضف فيديو إذا كان المشكل يهم الشجرة كلها.', en: 'Take 1 to 4 photos: the affected part up close, then the whole tree. Add a video if the problem affects the whole tree.' },
  take_photo:      { fr: '📷 Photo', ar: '📷 صورة', en: '📷 Photo' },
  pick_file:       { fr: '🖼️ Galerie', ar: '🖼️ المعرض', en: '🖼️ Gallery' },
  take_video:      { fr: '🎥 Vidéo (10-15 s)', ar: '🎥 فيديو (10-15 ث)', en: '🎥 Video (10–15 s)' },
  video_hint:      { fr: 'Filmez lentement : le sol, le tronc, puis le haut de l’arbre.', ar: 'صوّر ببطء: التربة، الجذع، ثم أعلى الشجرة.', en: 'Film slowly: the soil, the trunk, then the top of the tree.' },
  remove:          { fr: 'Retirer', ar: 'حذف', en: 'Remove' },

  q_organ:         { fr: 'Quel organe est touché ?', ar: 'أي عضو مصاب؟', en: 'Which part is affected?' },
  organ_leaf:      { fr: 'Feuilles', ar: 'الأوراق', en: 'Leaves' },
  organ_fruit:     { fr: 'Fruits', ar: 'الثمار', en: 'Fruit' },
  organ_branch:    { fr: 'Rameaux / branches', ar: 'الأغصان', en: 'Shoots / branches' },
  organ_trunk:     { fr: 'Tronc / collet', ar: 'الجذع / الطوق', en: 'Trunk / collar' },
  organ_whole:     { fr: 'Tout l’arbre', ar: 'الشجرة كاملة', en: 'The whole tree' },

  q_spread:        { fr: 'Combien d’arbres sont touchés ?', ar: 'كم شجرة مصابة؟', en: 'How many trees are affected?' },
  spread_one:      { fr: 'Un seul', ar: 'واحدة فقط', en: 'Just one' },
  spread_patch:    { fr: 'Une zone de la parcelle', ar: 'منطقة من القطعة', en: 'A patch of the plot' },
  spread_all:      { fr: 'Tout le verger', ar: 'البستان كله', en: 'The whole orchard' },

  q_onset:         { fr: 'Depuis quand ?', ar: 'منذ متى؟', en: 'Since when?' },
  onset_days:      { fr: 'Quelques jours', ar: 'بضعة أيام', en: 'A few days' },
  onset_weeks:     { fr: 'Quelques semaines', ar: 'بضعة أسابيع', en: 'A few weeks' },
  onset_season:    { fr: 'Cette saison', ar: 'هذا الموسم', en: 'This season' },
  onset_years:     { fr: 'Ça revient chaque année', ar: 'يتكرر كل سنة', en: 'It comes back every year' },

  q_irrigation:    { fr: 'Irrigation', ar: 'الري', en: 'Irrigation' },
  irr_drip:        { fr: 'Goutte à goutte', ar: 'بالتنقيط', en: 'Drip' },
  irr_flood:       { fr: 'Gravitaire / submersion', ar: 'بالجاذبية / الغمر', en: 'Flood' },
  irr_sprinkler:   { fr: 'Aspersion', ar: 'بالرش', en: 'Sprinkler' },
  irr_rain:        { fr: 'Pluvial (bour)', ar: 'بعلي', en: 'Rain-fed (bour)' },

  q_region:        { fr: 'Région (optionnel)', ar: 'الجهة (اختياري)', en: 'Region (optional)' },
  q_age:           { fr: 'Âge du verger (années)', ar: 'عمر البستان (سنوات)', en: 'Orchard age (years)' },
  q_notes:         { fr: 'Autre chose à signaler ?', ar: 'شيء آخر تريد ذكره؟', en: 'Anything else to mention?' },
  notes_ph:        { fr: 'Ex : eau de forage salée, grêle le mois dernier, traitement récent…', ar: 'مثلاً: ماء بئر مالح، بَرَد الشهر الماضي، معالجة حديثة…', en: 'E.g. saline borehole water, hail last month, a recent spray…' },

  analyse:         { fr: 'Analyser', ar: 'حلّل', en: 'Analyse' },
  analysing:       { fr: 'Analyse en cours…', ar: 'جاري التحليل…', en: 'Analysing…' },
  analysing_note:  { fr: 'Les images sont envoyées au modèle. Cela prend quelques secondes.', ar: 'يتم إرسال الصور إلى النموذج. يستغرق ذلك بضع ثوانٍ.', en: 'The images are being sent to the model. This takes a few seconds.' },

  confidence:      { fr: 'Confiance', ar: 'درجة الثقة', en: 'Confidence' },
  severity:        { fr: 'Gravité', ar: 'الخطورة', en: 'Severity' },
  sev_low:         { fr: 'Faible', ar: 'ضعيفة', en: 'Low' },
  sev_medium:      { fr: 'Moyenne', ar: 'متوسطة', en: 'Medium' },
  sev_high:        { fr: 'Élevée', ar: 'مرتفعة', en: 'High' },
  sev_critical:    { fr: 'Critique', ar: 'حرجة', en: 'Critical' },

  what_i_see:      { fr: 'Ce que je vois', ar: 'ما أراه', en: 'What I can see' },
  differentials:   { fr: 'Autres hypothèses', ar: 'فرضيات أخرى', en: 'Other possibilities' },
  actions_now:     { fr: 'À faire cette semaine', ar: 'ما يجب فعله هذا الأسبوع', en: 'Do this week' },
  treatment_bio:   { fr: 'Traitement biologique', ar: 'المعالجة البيولوجية', en: 'Organic treatment' },
  treatment_conv:  { fr: 'Traitement conventionnel', ar: 'المعالجة التقليدية', en: 'Conventional treatment' },
  prevention:      { fr: 'Pour la saison prochaine', ar: 'للموسم القادم', en: 'For next season' },
  guide_title:     { fr: 'Guide pas à pas', ar: 'دليل خطوة بخطوة', en: 'Step-by-step guide' },
  your_video:      { fr: 'Votre vidéo', ar: 'الفيديو ديالك', en: 'Your video' },
  more_video:      { fr: 'Chercher des vidéos', ar: 'ابحث عن فيديوهات', en: 'Find videos' },

  expert_flag:     { fr: 'Faites confirmer par un technicien', ar: 'اطلب تأكيداً من تقني', en: 'Get this confirmed by a technician' },
  expert_why:      { fr: 'Le modèle n’est pas assez sûr, ou l’enjeu est trop lourd pour agir sur une photo seule.', ar: 'النموذج ليس واثقاً بما يكفي، أو الرهان أثقل من أن يُبنى على صورة واحدة.', en: 'The model is not confident enough, or the stakes are too high to act on a photo alone.' },

  disclaimer:      { fr: 'Avis indicatif, pas une ordonnance. Vérifiez toujours l’homologation ONSSA du produit et le délai avant récolte sur son étiquette.', ar: 'رأي استرشادي وليس وصفة. تحقق دائماً من ترخيص ONSSA للمنتج ومهلة ما قبل الجني على ملصقه.', en: 'Guidance, not a prescription. Always check the product’s ONSSA registration and the pre-harvest interval on its label.' },

  play:            { fr: 'Lire', ar: 'تشغيل', en: 'Play' },
  pause:           { fr: 'Pause', ar: 'إيقاف مؤقت', en: 'Pause' },
  speak:           { fr: '🔊 Écouter', ar: '🔊 استمع', en: '🔊 Listen' },
  stop_speak:      { fr: '⏹ Arrêter', ar: '⏹ توقف', en: '⏹ Stop' },
  save:            { fr: 'Enregistrer', ar: 'حفظ', en: 'Save' },
  saved:           { fr: 'Enregistré', ar: 'تم الحفظ', en: 'Saved' },
  new_diagnosis:   { fr: 'Nouveau diagnostic', ar: 'تشخيص جديد', en: 'New diagnosis' },
  back:            { fr: 'Retour', ar: 'رجوع', en: 'Back' },
  next:            { fr: 'Continuer', ar: 'متابعة', en: 'Continue' },

  history_empty:   { fr: 'Aucun diagnostic enregistré pour l’instant.', ar: 'لا يوجد أي تشخيص محفوظ حالياً.', en: 'No saved diagnoses yet.' },
  export:          { fr: 'Exporter en JSON', ar: 'تصدير JSON', en: 'Export as JSON' },
  clear_history:   { fr: 'Vider l’historique', ar: 'إفراغ السجل', en: 'Clear history' },

  settings_key:    { fr: 'Clé API Gemini', ar: 'مفتاح Gemini API', en: 'Gemini API key' },
  settings_key_h:  { fr: 'Stockée uniquement sur cet appareil, jamais envoyée ailleurs qu’à Google. Obtenez-en une sur aistudio.google.com.', ar: 'يُخزَّن على هذا الجهاز فقط، ولا يُرسل إلا إلى Google. احصل على مفتاح من aistudio.google.com.', en: 'Stored on this device only and sent nowhere but Google. Get one at aistudio.google.com.' },
  settings_model:  { fr: 'Modèle', ar: 'النموذج', en: 'Model' },
  settings_model_h:{ fr: 'La liste est chargée depuis votre compte : seuls les modèles réellement disponibles apparaissent.', ar: 'تُحمَّل اللائحة من حسابك: تظهر فقط النماذج المتوفرة فعلاً.', en: 'The list is loaded from your account, so only models you actually have appear.' },
  refresh_models:  { fr: 'Rafraîchir la liste', ar: 'تحديث اللائحة', en: 'Refresh list' },
  demo_mode:       { fr: 'Mode démonstration', ar: 'وضع العرض', en: 'Demo mode' },
  demo_mode_h:     { fr: 'Sans clé API, l’application montre un diagnostic d’exemple pour que vous puissiez parcourir l’interface.', ar: 'بدون مفتاح API، يعرض التطبيق تشخيصاً نموذجياً لتتمكن من تصفح الواجهة.', en: 'With no API key, the app shows a sample diagnosis so you can walk through the interface.' },
  demo_badge:      { fr: 'Exemple — pas une vraie analyse', ar: 'نموذج — ليس تحليلاً حقيقياً', en: 'Sample — not a real analysis' },
  offline:         { fr: 'Hors ligne — les fiches restent consultables', ar: 'بدون اتصال — البطاقات تبقى متاحة', en: 'Offline — the library stays available' },

  err_nokey:       { fr: 'Aucune clé API. Ajoutez-en une dans Réglages, ou continuez en mode démonstration.', ar: 'لا يوجد مفتاح API. أضف واحداً في الإعدادات، أو تابع في وضع العرض.', en: 'No API key. Add one in Settings, or continue in demo mode.' },
  err_noimg:       { fr: 'Ajoutez au moins une photo.', ar: 'أضف صورة واحدة على الأقل.', en: 'Add at least one photo.' },
  err_api:         { fr: 'L’analyse a échoué.', ar: 'فشل التحليل.', en: 'The analysis failed.' },
  retry:           { fr: 'Réessayer', ar: 'أعد المحاولة', en: 'Try again' },

  err_key_invalid: { fr: 'Clé API invalide.', ar: 'مفتاح API غير صالح.', en: 'Invalid API key.' },
  err_key_refused: { fr: 'Clé API refusée. Vérifiez qu’elle est autorisée pour l’API Generative Language.', ar: 'تم رفض مفتاح API. تحقق من أنه مرخص لواجهة Generative Language.', en: 'API key refused. Check that it is enabled for the Generative Language API.' },
  err_quota:       { fr: 'Quota dépassé. Attendez une minute ou changez de modèle.', ar: 'تم تجاوز الحصة. انتظر دقيقة أو غيّر النموذج.', en: 'Quota exceeded. Wait a minute or switch model.' },
  err_model_gone:  { fr: 'Ce modèle n’est pas disponible sur votre compte. Rafraîchissez la liste dans Réglages.', ar: 'هذا النموذج غير متوفر في حسابك. حدّث اللائحة في الإعدادات.', en: 'This model is not available on your account. Refresh the list in Settings.' },
  err_server:      { fr: 'Erreur serveur chez Google. Réessayez dans un instant.', ar: 'خطأ في خادم Google. أعد المحاولة بعد لحظات.', en: 'Server error at Google. Try again in a moment.' },
  err_blocked:     { fr: 'Le modèle a bloqué la requête.', ar: 'حجب النموذج الطلب.', en: 'The model blocked the request.' },
  err_empty:       { fr: 'Le modèle n’a rien renvoyé.', ar: 'لم يُرجع النموذج أي شيء.', en: 'The model returned nothing.' },
  err_badjson:     { fr: 'Réponse du modèle illisible. Réessayez, ou changez de modèle.', ar: 'رد النموذج غير مقروء. أعد المحاولة أو غيّر النموذج.', en: 'The model\'s reply could not be read. Try again, or switch model.' },
  err_http:        { fr: 'La connexion au modèle a échoué.', ar: 'فشل الاتصال بالنموذج.', en: 'The connection to the model failed.' },
  err_nomodels:    { fr: 'Aucun modèle disponible sur ce compte.', ar: 'لا يوجد أي نموذج متاح في هذا الحساب.', en: 'No model is available on this account.' },
  models_found:    { fr: 'modèles disponibles', ar: 'نماذج متاحة', en: 'models available' },

  lib_signs:       { fr: 'Signes', ar: 'العلامات', en: 'Signs' },
  lib_confusion:   { fr: 'À ne pas confondre avec', ar: 'لا يُخلط مع', en: 'Not to be confused with' },
  lib_calendar:    { fr: 'Calendrier', ar: 'التقويم', en: 'Calendar' }
};

let current = 'fr';

export function setLang(l) {
  current = LANGS[l] ? l : 'fr';
  document.documentElement.lang = current;
  document.documentElement.dir = LANGS[current].dir;
  return current;
}
export function getLang() { return current; }
export function locale() { return LANGS[current].locale; }
export function t(key) {
  const e = S[key];
  if (!e) return key;
  return e[current] || e.fr;
}
// Pick the current language out of a {fr,ar,en} object coming from the knowledge base.
export function tx(obj, fallback = '') {
  if (!obj) return fallback;
  if (typeof obj === 'string') return obj;
  return obj[current] || obj.fr || obj.en || fallback;
}
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}
