import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AutoLoginResult, AutoLoginStatus, IgState } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { ConfirmButton, ErrorNote, Spinner } from './ui';

const RESULT: Record<AutoLoginResult, string> = {
  logged_in: 'logged in',
  failed: 'Instagram did not accept it (wrong password?)',
  challenge: 'Instagram asked for a check — answer it on the screen',
  no_form: 'the login form was not on the screen',
  covered: 'something covered the login form',
  busy: 'you were using the screen',
  error: 'the browser could not be reached',
};

/**
 * The saved Instagram login: when Instagram ends the session, the server types it into the login page by itself
 * (server/src/ig/autologin.ts). The password is write-only: it is sent once and cleared from the form.
 */
export function AutoLoginPanel({ igState }: { igState: IgState | undefined }) {
  const [status, setStatus] = useState<AutoLoginStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.autoLogin().then(setStatus, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load, igState]);
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [status?.running, load]);

  const run = async (fn: () => Promise<AutoLoginStatus | void>, done?: string) => {
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

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const s = await api.saveAutoLogin({ username: username.trim(), password, enabled: true });
      setPassword('');
      setUsername('');
      return s;
    }, 'Saved.');
  };

  const loginNow = () =>
    run(async () => {
      const r = await api.runAutoLogin();
      const text = {
        started: 'Logging in — watch the screen below.',
        not_on_login_page: 'The Instagram screen is not on the login page.',
        not_saved: 'Save a login first.',
        busy: 'Already logging in.',
      }[r.result];
      setNote(text);
      return api.autoLogin();
    });

  const last =
    status?.lastAttemptAt && status.lastResult
      ? `Last try ${new Date(status.lastAttemptAt).toLocaleString()}: ${RESULT[status.lastResult]}.`
      : null;

  return (
    <details className="session-import autologin" open={status !== null && !status.saved}>
      <summary>
        Automatic login {status?.saved ? (status.enabled ? (status.paused ? '— paused' : '— on') : '— off') : '— not set up'}
      </summary>
      <p className="small">
        When Instagram ends the session, insta_logger logs back in by itself on the screen below: it moves the mouse and types your
        username and password like a person would, once per logout. It waits while you use the screen yourself, stops after two failed
        tries, and leaves checks and 2FA codes to you.
      </p>
      {status?.saved ? (
        <div className="row gap wrap autologin-state">
          <span>
            Saved for <b>{status.username}</b>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(e) => void run(() => api.saveAutoLogin({ enabled: e.target.checked }))}
            />{' '}
            Log in automatically
          </label>
          {status.running ? (
            <span className="muted small">
              <Spinner size={14} /> logging in…
            </span>
          ) : null}
        </div>
      ) : null}
      {status?.paused ? <p className="small warn-text">Paused after failed tries. Check the password, save it again or press “Log in now”.</p> : null}
      {last ? <p className="muted small">{last}</p> : null}
      <form onSubmit={save} className="form autologin-form" autoComplete="off">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Instagram username, phone or email"
          aria-label="Instagram username"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={status?.saved ? 'New password' : 'Instagram password'}
          aria-label="Instagram password"
          autoComplete="new-password"
          maxLength={256}
        />
        <p className="muted small">
          Stored encrypted on your server and never shown again. The server has to read it without you, so someone with full access
          to the server could recover it — like the Instagram session it already keeps.
        </p>
        <ErrorNote error={error} />
        {note ? <p className="ok-note small">{note}</p> : null}
        <div className="row gap wrap">
          <button className="btn primary" disabled={busy || !username.trim() || !password}>
            {busy ? <Spinner size={18} /> : status?.saved ? 'Replace login' : 'Save login'}
          </button>
        </div>
      </form>
      {status?.saved ? (
        <div className="row gap wrap autologin-actions">
          {igState === 'login' || status.paused ? (
            <button type="button" className="btn" disabled={busy || status.running || igState !== 'login'} onClick={() => void loginNow()}>
              Log in now
            </button>
          ) : null}
          <ConfirmButton className="btn ghost" confirmLabel="Forget the saved login" onConfirm={() => run(() => api.removeAutoLogin(), 'Forgotten.')}>
            Forget
          </ConfirmButton>
        </div>
      ) : null}
    </details>
  );
}
