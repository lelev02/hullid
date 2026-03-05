/**
 * HullID - Persistence Manager v2
 * Adattato alla struttura reale: watchlist usa barca_nome come chiave
 *
 * INCLUDE in fondo a ogni pagina, dopo supabase init:
 * <script src="js/hullid-persistence.js"></script>
 *
 * Poi usa window.HullID.Watchlist, HullID.Note, ecc.
 */

(function () {
  'use strict';

  // ── attendi che window._sb sia disponibile ──────────────────
  function waitForSb(cb) {
    if (window._sb) return cb();
    const t = setInterval(() => { if (window._sb) { clearInterval(t); cb(); } }, 80);
  }

  // ── chiavi localStorage ─────────────────────────────────────
  const LS = {
    watchlist:  'hullid_watchlist',
    note:       'hullid_note',
    preferenze: 'hullid_preferenze',
    ricerche:   'hullid_ricerche'
  };

  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.warn('[HullID] LS write fail', e); } };
  const emit  = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

  // ── helper: user corrente ───────────────────────────────────
  async function uid() {
    try { return (await window._sb.auth.getSession()).data?.session?.user?.id || null; }
    catch { return null; }
  }

  // ============================================================
  // WATCHLIST  (chiave: barca_nome)
  // ============================================================
  const Watchlist = {

    /** Restituisce array di oggetti barca salvati in locale */
    getLocal() { return lsGet(LS.watchlist) || []; },

    /** Controlla se barca_nome è in watchlist */
    has(barcaNome) {
      return this.getLocal().some(b => b.barca_nome === barcaNome);
    },

    /**
     * Aggiunge barca alla watchlist
     * @param {object} barca - { barca_nome, barca_nome_completo, barca_meta, barca_prezzo, barca_badge, barca_badge_label, barca_emoji }
     */
    async add(barca) {
      if (!barca.barca_nome) return console.warn('[HullID] barca_nome richiesto');

      // 1. locale ottimistico
      const list = this.getLocal();
      if (!list.some(b => b.barca_nome === barca.barca_nome)) {
        list.push({ ...barca, saved_at: new Date().toISOString() });
        lsSet(LS.watchlist, list);
      }
      emit('watchlist:changed', { barcaNome: barca.barca_nome, action: 'add' });

      // 2. Supabase
      const userId = await uid();
      if (!userId) return { local: true, synced: false };

      const { error } = await window._sb.from('watchlist').upsert(
        { user_id: userId, ...barca },
        { onConflict: 'user_id,barca_nome' }
      );
      if (error) console.warn('[HullID] Watchlist add error:', error.message);
      return { local: true, synced: !error };
    },

    async remove(barcaNome) {
      lsSet(LS.watchlist, this.getLocal().filter(b => b.barca_nome !== barcaNome));
      emit('watchlist:changed', { barcaNome, action: 'remove' });

      const userId = await uid();
      if (!userId) return { local: true, synced: false };

      const { error } = await window._sb.from('watchlist')
        .delete().eq('user_id', userId).eq('barca_nome', barcaNome);
      if (error) console.warn('[HullID] Watchlist remove error:', error.message);
      return { local: true, synced: !error };
    },

    async toggle(barca) {
      const nome = typeof barca === 'string' ? barca : barca.barca_nome;
      if (this.has(nome)) return this.remove(nome);
      return this.add(typeof barca === 'string' ? { barca_nome: barca } : barca);
    },

    /** Scarica watchlist dal server e aggiorna localStorage */
    async syncFromServer() {
      const userId = await uid();
      if (!userId) return this.getLocal();

      const { data, error } = await window._sb.from('watchlist')
        .select('*').eq('user_id', userId).order('created_at', { ascending: false });

      if (error) { console.warn('[HullID] Watchlist fetch:', error.message); return this.getLocal(); }
      lsSet(LS.watchlist, data || []);
      emit('watchlist:synced', { list: data || [] });
      return data || [];
    }
  };

  // ============================================================
  // NOTE  (chiave: barca_nome)
  // ============================================================
  const Note = {

    getAllLocal() { return lsGet(LS.note) || {}; },
    get(barcaNome) { return this.getAllLocal()[barcaNome] || ''; },

    async save(barcaNome, testo) {
      const all = this.getAllLocal();
      all[barcaNome] = testo;
      lsSet(LS.note, all);
      emit('note:saved', { barcaNome, testo });

      const userId = await uid();
      if (!userId) return { local: true, synced: false };

      const { error } = await window._sb.from('note_barche').upsert(
        { user_id: userId, barca_nome: barcaNome, testo },
        { onConflict: 'user_id,barca_nome' }
      );
      if (error) console.warn('[HullID] Note save error:', error.message);
      return { local: true, synced: !error };
    },

    async delete(barcaNome) {
      const all = this.getAllLocal();
      delete all[barcaNome];
      lsSet(LS.note, all);

      const userId = await uid();
      if (!userId) return;
      await window._sb.from('note_barche')
        .delete().eq('user_id', userId).eq('barca_nome', barcaNome);
    },

    async syncFromServer() {
      const userId = await uid();
      if (!userId) return this.getAllLocal();

      const { data, error } = await window._sb.from('note_barche')
        .select('barca_nome, testo').eq('user_id', userId);

      if (error) return this.getAllLocal();
      const map = {};
      (data || []).forEach(r => { map[r.barca_nome] = r.testo; });
      lsSet(LS.note, map);
      return map;
    }
  };

  // ============================================================
  // PREFERENZE
  // ============================================================
  const Preferenze = {
    DEFAULTS: { layout: 'grid', notifiche_email: true, notifiche_watchlist: true },

    getLocal() { return Object.assign({}, this.DEFAULTS, lsGet(LS.preferenze) || {}); },
    get(k) { return this.getLocal()[k]; },

    async set(k, v) { return this.setMulti({ [k]: v }); },

    async setMulti(obj) {
      const prefs = Object.assign(this.getLocal(), obj);
      lsSet(LS.preferenze, prefs);
      emit('preferenze:changed', prefs);

      const userId = await uid();
      if (!userId) return { local: true, synced: false };

      const { error } = await window._sb.from('preferenze_utente').upsert(
        { user_id: userId, ...prefs },
        { onConflict: 'user_id' }
      );
      if (error) console.warn('[HullID] Preferenze save error:', error.message);
      return { local: true, synced: !error };
    },

    async syncFromServer() {
      const userId = await uid();
      if (!userId) return this.getLocal();

      const { data, error } = await window._sb.from('preferenze_utente')
        .select('layout, notifiche_email, notifiche_watchlist, dashboard_widgets, extra')
        .eq('user_id', userId).single();

      if (error || !data) return this.getLocal();
      lsSet(LS.preferenze, data);
      return data;
    }
  };

  // ============================================================
  // RICERCHE SALVATE
  // ============================================================
  const RicercheSalvate = {
    getLocal() { return lsGet(LS.ricerche) || []; },

    async save(nome, filtri, notificaNuovi = false) {
      const userId = await uid();

      if (!userId) {
        const list = this.getLocal();
        const item = { id: 'local_' + Date.now(), nome, filtri, notifica_nuovi: notificaNuovi };
        list.push(item);
        lsSet(LS.ricerche, list);
        return { local: true, synced: false, data: item };
      }

      const { data, error } = await window._sb.from('ricerche_salvate')
        .insert({ user_id: userId, nome, filtri, notifica_nuovi: notificaNuovi })
        .select().single();

      if (!error && data) {
        const list = this.getLocal();
        list.unshift(data);
        lsSet(LS.ricerche, list);
        emit('ricerche:saved', data);
      } else {
        console.warn('[HullID] Ricerche save error:', error?.message);
      }
      return { local: !error, synced: !error, data };
    },

    async delete(id) {
      lsSet(LS.ricerche, this.getLocal().filter(r => r.id !== id));
      const userId = await uid();
      if (!userId || String(id).startsWith('local_')) return;
      await window._sb.from('ricerche_salvate')
        .delete().eq('id', id).eq('user_id', userId);
    },

    async syncFromServer() {
      const userId = await uid();
      if (!userId) return this.getLocal();

      const { data, error } = await window._sb.from('ricerche_salvate')
        .select('*').eq('user_id', userId).order('created_at', { ascending: false });

      if (error) return this.getLocal();
      lsSet(LS.ricerche, data || []);
      return data || [];
    }
  };

  // ============================================================
  // SYNC ALL + AUTH LISTENER
  // ============================================================
  async function syncAll() {
    console.log('[HullID] ⟳ Sync in corso...');
    await Promise.all([
      Watchlist.syncFromServer(),
      Note.syncFromServer(),
      Preferenze.syncFromServer(),
      RicercheSalvate.syncFromServer()
    ]);
    emit('hullid:synced', {});
    console.log('[HullID] ✓ Sync completato');
  }

  waitForSb(() => {
    window._sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN'  && session) syncAll();
      if (event === 'SIGNED_OUT') {
        Object.values(LS).forEach(k => localStorage.removeItem(k));
        emit('hullid:logout', {});
      }
    });
    window._sb.auth.getSession().then(({ data }) => {
      if (data?.session) syncAll();
    });
  });

  // ============================================================
  // TOAST HELPER
  // ============================================================
  function showToast(msg, duration = 2800) {
    let t = document.getElementById('hullid-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hullid-toast';
      t.style.cssText = [
        'position:fixed','bottom:24px','right:24px','z-index:9999',
        'background:#0f172a','color:#f8fafc','padding:11px 18px',
        'border-radius:10px','font-size:13.5px','font-family:inherit',
        'box-shadow:0 4px 24px rgba(0,0,0,.35)','opacity:0',
        'transition:opacity .2s ease','pointer-events:none','max-width:320px'
      ].join(';');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.style.opacity = '0'; }, duration);
  }

  // ============================================================
  // EXPORT GLOBALE
  // ============================================================
  window.HullID = Object.assign(window.HullID || {}, {
    Watchlist,
    Note,
    Preferenze,
    RicercheSalvate,
    syncAll,
    showToast
  });

  console.log('[HullID] ✓ Persistence module ready');

})();
