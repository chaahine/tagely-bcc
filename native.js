// ══════════════════════════════════════════════════════════════════════════
// Stagely — couche native (Capacitor)
// ══════════════════════════════════════════════════════════════════════════
// Chargé par index.html ET portal.html. Sur le web, tout ici se dégrade
// silencieusement : aucune fonctionnalité existante ne dépend de ce fichier,
// il n'ajoute que ce que la version native sait faire en plus.
//
// ── Pourquoi ce fichier existe ──
// L'app iOS/Android est une coquille Capacitor dont la WebView charge le site
// en ligne (capacitor.config.json, server.url). Une app qui se contente
// d'afficher un site web se fait rejeter par Apple au titre de la guideline
// 4.2 "Minimum Functionality" : elle doit apporter quelque chose qu'un
// navigateur ne donne pas. Ce fichier apporte ce quelque chose, et le
// choisit utile plutôt que décoratif :
//   - des rappels programmés sur l'appareil (la deadline de dispos du club),
//   - le partage natif du lien portail (feuille de partage système),
//   - le bouton retour Android qui navigue au lieu de fermer l'app,
//   - la barre d'état accordée au thème sombre, et un retour haptique.
//
// ── Aucune infrastructure requise ──
// Ce sont des notifications LOCALES, pas des push : elles sont programmées
// par l'appareil, pour l'appareil. Pas de Firebase, pas de certificat APNs,
// pas de serveur d'envoi, rien à configurer avant publication. Le jour où de
// vraies push serveur seront utiles, elles viendront s'ajouter — elles ne
// sont pas un prérequis à la mise en ligne.
//
// Le bridge Capacitor est injecté dans la WebView même quand la page vient
// d'un serveur distant : les plugins s'appellent donc directement via
// window.Capacitor.Plugins, sans bundler ni import ES — cohérent avec le
// reste du projet, qui n'a pas d'étape de build.

(function () {
  'use strict';

  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const P = (Cap && Cap.Plugins) || {};
  const platform = (Cap && typeof Cap.getPlatform === 'function') ? Cap.getPlatform() : 'web';

  // Identifiants fixes : reprogrammer écrase le rappel précédent au lieu
  // d'empiler un doublon à chaque sauvegarde des réglages.
  const NOTIF_ID_AHEAD = 4201;   // quelques jours avant la deadline
  const NOTIF_ID_DAY = 4202;     // le jour même
  const REMINDER_PREF_KEY = 'stagely_native_reminders';

  const log = (...a) => { try { console.log('[Stagely/native]', ...a); } catch (e) {} };

  // ── Partage ───────────────────────────────────────────────────────────
  // Trois niveaux, du meilleur au dernier recours : feuille de partage
  // native, Web Share API, presse-papiers. Retourne le canal réellement
  // utilisé pour que l'appelant affiche le bon message ("partagé" vs
  // "copié"), plutôt que de mentir sur ce qui vient de se passer.
  async function share({ title, text, url } = {}) {
    const payload = { title: title || 'Stagely', text: text || '', url: url || '' };
    if (isNative && P.Share) {
      try {
        await P.Share.share({ ...payload, dialogTitle: payload.title });
        return 'native';
      } catch (e) {
        // L'utilisateur qui ferme la feuille de partage lève aussi une
        // erreur : on ne retombe pas sur le presse-papiers dans ce cas, ça
        // afficherait un "copié" qu'il n'a pas demandé.
        if (/cancel/i.test(String(e && e.message))) return 'cancelled';
      }
    }
    if (navigator.share) {
      try { await navigator.share(payload); return 'web'; }
      catch (e) { if (/abort/i.test(String(e && e.name))) return 'cancelled'; }
    }
    try {
      await navigator.clipboard.writeText(url || text || '');
      return 'clipboard';
    } catch (e) { return 'failed'; }
  }

  // ── Retour haptique ───────────────────────────────────────────────────
  // Volontairement silencieux et sans await côté appelant : un retour
  // haptique ne doit jamais retarder ni faire échouer l'action réelle.
  function tap(style) {
    if (!isNative || !P.Haptics) return;
    try {
      if (style === 'success') P.Haptics.notification({ type: 'SUCCESS' });
      else if (style === 'error') P.Haptics.notification({ type: 'ERROR' });
      else P.Haptics.impact({ style: 'LIGHT' });
    } catch (e) { /* jamais bloquant */ }
  }

  // ── Rappels locaux ────────────────────────────────────────────────────
  function remindersEnabled() {
    try { return localStorage.getItem(REMINDER_PREF_KEY) === '1'; } catch (e) { return false; }
  }
  function setRemindersEnabled(v) {
    try { localStorage.setItem(REMINDER_PREF_KEY, v ? '1' : '0'); } catch (e) {}
  }

  async function permissionState() {
    if (!isNative || !P.LocalNotifications) return 'unsupported';
    try {
      const r = await P.LocalNotifications.checkPermissions();
      return (r && r.display) || 'prompt';
    } catch (e) { return 'unsupported'; }
  }

  // Demande la permission système. Appelée uniquement sur action explicite
  // de l'utilisateur (bouton dans Réglages) : une demande de notification
  // surgie au premier lancement se fait refuser dans la majorité des cas, et
  // le refus est définitif tant que l'utilisateur ne va pas dans les
  // réglages système.
  async function requestPermission() {
    if (!isNative || !P.LocalNotifications) return 'unsupported';
    try {
      const r = await P.LocalNotifications.requestPermissions();
      return (r && r.display) || 'denied';
    } catch (e) { return 'denied'; }
  }

  function clampDay(d) {
    const n = Number(d);
    if (!Number.isFinite(n)) return 12;
    // 28 et pas 31 : un rappel programmé le 30 ne se déclencherait jamais en
    // février. Mieux vaut un rappel un peu tôt qu'un rappel jamais reçu.
    return Math.min(28, Math.max(1, Math.round(n)));
  }

  // Programme deux rappels mensuels récurrents autour de la deadline de
  // dispos du club : un en amont pour laisser le temps d'agir, un le jour
  // même. `repeats: true` avec un `on` partiel (jour + heure) signifie
  // "chaque mois à cette date" côté Capacitor.
  async function scheduleDeadlineReminders(deadlineDay, clubName) {
    if (!isNative || !P.LocalNotifications) return false;
    const day = clampDay(deadlineDay);
    const ahead = day - 3 >= 1 ? day - 3 : 1;
    const club = clubName || 'ton club';
    try {
      await P.LocalNotifications.cancel({
        notifications: [{ id: NOTIF_ID_AHEAD }, { id: NOTIF_ID_DAY }],
      });
      await P.LocalNotifications.schedule({
        notifications: [
          {
            id: NOTIF_ID_AHEAD,
            title: 'Dispos à confirmer',
            body: `Plus que 3 jours pour boucler les disponibilités de ${club}.`,
            schedule: { on: { day: ahead, hour: 10, minute: 0 }, repeats: true, allowWhileIdle: true },
          },
          {
            id: NOTIF_ID_DAY,
            title: "C'est aujourd'hui la deadline",
            body: `Dernier jour pour les disponibilités de ${club}.`,
            schedule: { on: { day, hour: 9, minute: 0 }, repeats: true, allowWhileIdle: true },
          },
        ],
      });
      setRemindersEnabled(true);
      log('rappels programmés :', ahead, 'et', day);
      return true;
    } catch (e) {
      log('échec de programmation des rappels :', e && e.message);
      return false;
    }
  }

  async function cancelReminders() {
    setRemindersEnabled(false);
    if (!isNative || !P.LocalNotifications) return;
    try {
      await P.LocalNotifications.cancel({
        notifications: [{ id: NOTIF_ID_AHEAD }, { id: NOTIF_ID_DAY }],
      });
    } catch (e) { /* rien à annuler */ }
  }

  // Reprogrammation silencieuse : appelée quand la deadline du club change
  // ou quand l'app se rouvre. Ne redemande JAMAIS la permission — si
  // l'utilisateur n'a pas activé les rappels, on ne fait rien.
  async function refreshReminders(deadlineDay, clubName) {
    if (!isNative || !remindersEnabled()) return;
    if ((await permissionState()) !== 'granted') return;
    await scheduleDeadlineReminders(deadlineDay, clubName);
  }

  // Active les rappels sur demande explicite. Retourne un code que
  // l'appelant traduit en message : c'est l'UI qui parle à l'utilisateur,
  // pas cette couche.
  async function enableReminders(deadlineDay, clubName) {
    if (!isNative) return 'unsupported';
    let state = await permissionState();
    if (state === 'prompt' || state === 'prompt-with-rationale') state = await requestPermission();
    if (state !== 'granted') return 'denied';
    return (await scheduleDeadlineReminders(deadlineDay, clubName)) ? 'enabled' : 'failed';
  }

  // ── Intégration système ───────────────────────────────────────────────
  function setupStatusBar() {
    if (!isNative || !P.StatusBar) return;
    try {
      // L'app est intégralement sur fond sombre : texte de la barre d'état
      // en clair, sinon il devient illisible sur iOS.
      P.StatusBar.setStyle({ style: 'DARK' });
      if (platform === 'android') P.StatusBar.setBackgroundColor({ color: '#080810' });
    } catch (e) { /* non critique */ }
  }

  // Bouton retour Android : par défaut Capacitor ferme l'app à la première
  // pression, ce qui est brutal au milieu d'une navigation. On ferme d'abord
  // ce qui est ouvert (modale, menu), puis on revient en arrière, et on ne
  // quitte que depuis la racine.
  function setupBackButton() {
    if (!isNative || !P.App || platform !== 'android') return;
    try {
      P.App.addListener('backButton', ({ canGoBack }) => {
        const openOverlay = document.querySelector('.overlay.open');
        if (openOverlay) { openOverlay.classList.remove('open'); return; }
        const menu = document.getElementById('club-menu');
        if (menu && menu.style.display === 'block') { menu.style.display = 'none'; return; }
        if (canGoBack) { window.history.back(); return; }
        P.App.exitApp();
      });
    } catch (e) { /* non critique */ }
  }

  // Retour au premier plan : les rappels sont reprogrammés si l'utilisateur
  // les a activés. Utile après une mise à jour de l'app ou un redémarrage de
  // l'appareil, où le système peut avoir purgé les notifications planifiées.
  function setupResumeHook() {
    if (!isNative || !P.App) return;
    try {
      P.App.addListener('resume', () => {
        const club = window.currentClub;
        if (club) refreshReminders(club.dispo_deadline_day, club.name);
      });
    } catch (e) { /* non critique */ }
  }

  window.StagelyNative = {
    isNative,
    platform,
    share,
    tap,
    enableReminders,
    cancelReminders,
    refreshReminders,
    remindersEnabled,
    permissionState,
  };

  if (isNative) {
    setupStatusBar();
    setupBackButton();
    setupResumeHook();
    log('couche native active —', platform);
  }
})();
