import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { IgState, SyncHomeResult, SyncHomeStatus, SyncRemoteResult, SyncRemoteStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { RecoveryKeyBox } from '../pages/Auth';
import { useAppState } from '../state/AppState';
import { ConfirmButton, ErrorNote, Spinner } from './ui';

const HOME_RESULT: Record<SyncHomeResult, string> = {
  given: 'a session was given',
  challenge: 'Instagram asked for a check — log in on the screen yourself',
  failed: 'Instagram did not accept the saved password',
  no_form: 'the login form was not on the screen',
  covered: 'something covered the login form',
  busy: 'the screen was in use',
  error: 'the browser could not be reached',
  no_password: 'no saved password (Automatic login)',
  cooldown: 'asked again too soon',
  paused: 'paused after failed logins',
};

const REMOTE_RESULT: Record<SyncRemoteResult, string> = {
  logged_in: 'logged in with a session from the home',
  unreachable: 'the home address did not answer',
  refused: 'the home did not accept the pairing — pair again',
  home_busy: 'the home was busy',
  home_cooldown: 'the home asks to wait (one session per 15 minutes)',
  home_paused: 'the home paused after failed logins',
  home_no_password: 'the home has no saved password (Automatic login there)',
  home_challenge: 'Instagram asked the home for a check',
  home_failed: 'the home could not log in',
  not_taken: 'the browser did not take the session',
  error: 'something went wrong',
};

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '');

function useAction<T>(setStatus: (s: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<T | void>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const s = await fn();
      if (s) setStatus(s);
      if (done) setNote(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, setNote, run };
}

/**
 * Session sync (server/src/sync/): this insta_logger can give separate Instagram sessions to a paired one that can't log
 * in itself (e.g. on a VPS), and/or get sessions from one that can. The pairing code is shown once and is write-only.
 */
export function SessionSyncPanel({ igState }: { igState: IgState | undefined }) {
  const [home, setHome] = useState<SyncHomeStatus | null>(null);
  const [remote, setRemote] = useState<SyncRemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.syncHome().then(setHome, (e) => setLoadError(errorMessage(e)));
    api.syncRemote().then(setRemote, (e) => setLoadError(errorMessage(e)));
  }, []);
  useEffect(load, [load, igState]);
  useEffect(() => {
    if (!home?.running && !remote?.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [home?.running, remote?.running, load]);

  const label = remote?.configured ? '— getting sessions' : home?.paired ? '— giving sessions' : '— not set up';
  return (
    <details className="session-import session-sync">
      <summary>Session sync {label}</summary>
      <p className="small">
        For a second insta_logger with the same Instagram account that can't log in itself — Instagram hides the login form from
        datacenter addresses. The one that can log in (“home”) makes a separate login when the other one (“remote”) is logged out, and
        hands it over encrypted.
      </p>
      <ErrorNote error={loadError} />
      <GiveSection status={home} setStatus={setHome} />
      <GetSection status={remote} setStatus={setRemote} igState={igState} />
    </details>
  );
}

function GiveSection({ status, setStatus }: { status: SyncHomeStatus | null; setStatus: (s: SyncHomeStatus) => void }) {
  const { state } = useAppState();
  const { busy, error, note, run } = useAction(setStatus);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const pair = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.syncPair({ password, ...(totp.trim() ? { totp: totp.trim() } : {}) });
      setPassword('');
      setTotp('');
      setAsking(false);
      setCode(r.code);
      return api.syncHome();
    });
  };

  const last = status?.lastRequestAt && status.lastResult ? `Last request ${when(status.lastRequestAt)}: ${HOME_RESULT[status.lastResult]}.` : null;
  return (
    <section className="sync-side">
      <h4>Give sessions (this is the home)</h4>
      {status?.paired ? (
        <p className="small">
          Paired since {when(status.pairedAt)}.{' '}
          {status.running ? (
            <span className="muted">
              <Spinner size={14} /> logging in for the remote…
            </span>
          ) : null}
        </p>
      ) : (
        <p className="muted small">Not paired. Create a pairing code and paste it on the other insta_logger.</p>
      )}
      {status && !status.passwordSaved ? <p className="small warn-text">Save your Instagram login under “Automatic login” first: it makes the separate logins.</p> : null}
      {status?.pausedUntil ? <p className="small warn-text">Paused until {when(status.pausedUntil)} after failed logins.</p> : null}
      {last ? <p className="muted small">{last}</p> : null}
      {code ? (
        <div className="sync-code">
          <p className="small">
            Paste this code on the other insta_logger (Instagram page → Session sync → Get sessions). It is shown only now; it lets
            that insta_logger get sessions of this account.
          </p>
          <RecoveryKeyBox recoveryKey={code} />
          <button type="button" className="btn ghost" onClick={() => setCode(null)}>
            Done
          </button>
        </div>
      ) : null}
      <ErrorNote error={error} />
      {note ? <p className="ok-note small">{note}</p> : null}
      {asking ? (
        <form onSubmit={pair} className="form" autoComplete="off">
          <label>
            Your insta_logger password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {state?.totpEnabled ? (
            <label>
              Authentication code
              <input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} required pattern="[0-9 ]{6,7}" />
            </label>
          ) : null}
          <div className="row gap wrap">
            <button className="btn primary" disabled={busy || !password}>
              {busy ? <Spinner size={18} /> : status?.paired ? 'Replace pairing' : 'Create pairing code'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row gap wrap">
          <button type="button" className="btn" disabled={busy} onClick={() => setAsking(true)}>
            {status?.paired ? 'New pairing code' : 'Create pairing code'}
          </button>
          {status?.pausedUntil ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.syncResume(), 'Allowed again.')}>
              Allow again
            </button>
          ) : null}
          {status?.paired ? (
            <ConfirmButton className="btn ghost" confirmLabel="Remove the pairing" onConfirm={() => run(() => api.syncUnpair(), 'Pairing removed.')}>
              Unpair
            </ConfirmButton>
          ) : null}
        </div>
      )}
    </section>
  );
}

function GetSection({ status, setStatus, igState }: { status: SyncRemoteStatus | null; setStatus: (s: SyncRemoteStatus) => void; igState: IgState | undefined }) {
  const { busy, error, note, setNote, run } = useAction(setStatus);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const s = await api.saveSyncRemote({ url: url.trim(), code: code.trim(), enabled: true });
      setCode('');
      setUrl('');
      return s;
    }, 'Saved.');
  };

  const getNow = () =>
    run(async () => {
      const r = await api.runSyncRemote();
      setNote(
        {
          started: 'Asking the home — it logs in on its own screen, this takes about a minute.',
          not_on_login_page: 'Instagram is not logged out here.',
          not_configured: 'Save the home address and pairing code first.',
          busy: 'Already asking.',
        }[r.result],
      );
      return api.syncRemote();
    });

  const last = status?.lastAttemptAt && status.lastResult ? `Last try ${when(status.lastAttemptAt)}: ${REMOTE_RESULT[status.lastResult]}.` : null;
  return (
    <section className="sync-side">
      <h4>Get sessions (this is the remote)</h4>
      {status?.configured ? (
        <div className="row gap wrap autologin-state">
          <span>
            From <b className="mono">{status.url}</b>
          </span>
          <label className="switch">
            <input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => void run(() => api.saveSyncRemote({ enabled: e.target.checked }))} /> Get a session
            automatically when logged out
          </label>
          {status.running ? (
            <span className="muted small">
              <Spinner size={14} /> asking the home…
            </span>
          ) : null}
        </div>
      ) : null}
      {status?.paused ? <p className="small warn-text">Paused after failed tries. Check the home, save again or press “Get session now”.</p> : null}
      {last ? <p className="muted small">{last}</p> : null}
      <form onSubmit={save} className="form" autoComplete="off">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Home address, e.g. http://ipvis-vpn:8091"
          aria-label="Home insta_logger address"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={300}
        />
        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Pairing code from the home (igls1.…)"
          aria-label="Pairing code"
          autoComplete="off"
          maxLength={200}
        />
        <p className="muted small">The code is stored encrypted here and never shown again. The session travels encrypted end to end, also over plain HTTP.</p>
        <ErrorNote error={error} />
        {note ? <p className="ok-note small">{note}</p> : null}
        <div className="row gap wrap">
          <button className="btn primary" disabled={busy || !url.trim() || !code.trim()}>
            {busy ? <Spinner size={18} /> : status?.configured ? 'Replace' : 'Save'}
          </button>
          {status?.configured && (igState === 'login' || igState === 'challenge') ? (
            <button type="button" className="btn" disabled={busy || status.running} onClick={() => void getNow()}>
              Get session now
            </button>
          ) : null}
          {status?.configured ? (
            <ConfirmButton className="btn ghost" confirmLabel="Forget the home" onConfirm={() => run(() => api.removeSyncRemote(), 'Forgotten.')}>
              Forget
            </ConfirmButton>
          ) : null}
        </div>
      </form>
    </section>
  );
}
