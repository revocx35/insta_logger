import QRCode from 'qrcode';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AuditEntry, SessionInfo, Settings, TotpSetupResponse } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ConfirmButton, ErrorNote, Spinner, IgStatePill } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useAppState } from '../state/AppState';
import { RecoveryKeyBox } from './Auth';

function Section({ id, title, children, danger = false }: { id: string; title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section id={id} className={danger ? 'settings-section danger' : 'settings-section'}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      if (success) setOk(success);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, ok, run };
}

function PasswordSection() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return;
    if (await a.run(() => api.changePassword(cur, next), 'Password changed. Other sessions were logged out.')) {
      setCur('');
      setNext('');
      setConfirm('');
    }
  };
  return (
    <Section id="password" title="Password">
      <form className="form narrow" onSubmit={submit}>
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
        </label>
        <label>
          Confirm new password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {next && confirm && next !== confirm ? <p className="error-note">Passwords do not match.</p> : null}
        <ErrorNote error={a.error} />
        {a.ok ? <p className="ok-note">{a.ok}</p> : null}
        <button className="btn primary" disabled={a.busy}>
          Change password
        </button>
      </form>
    </Section>
  );
}

function TotpSection() {
  const { state, refresh } = useAppState();
  const enabled = !!state?.totpEnabled;
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const a = useAsync();

  const start = () =>
    a.run(async () => {
      const s = await api.totpSetup();
      setSetup(s);
      setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 220 }));
    });

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.totpEnable(code.trim(), password), 'Two-factor authentication enabled.')) {
      setSetup(null);
      setQr(null);
      setCode('');
      setPassword('');
      await refresh();
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.totpDisable(password, code.trim()), 'Two-factor authentication disabled.')) {
      setPassword('');
      setCode('');
      await refresh();
    }
  };

  return (
    <Section id="2fa" title="Two-factor authentication (TOTP)">
      <p className="muted">Require a 6-digit code from an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) at login.</p>
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
      {enabled ? (
        <form className="form narrow" onSubmit={disable}>
          <p className="ok-note">
            <Icon name="shield" size={16} /> Two-factor authentication is enabled.
          </p>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label>
            Current code
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern="[0-9 ]{6,7}" />
          </label>
          <ErrorNote error={a.error} />
          <button className="btn danger" disabled={a.busy}>
            Disable 2FA
          </button>
        </form>
      ) : setup ? (
        <form className="form narrow" onSubmit={enable}>
          {qr ? <img src={qr} alt="Scan this QR code with your authenticator app" className="totp-qr" width={220} height={220} /> : null}
          <p className="small muted">
            Or enter this secret manually: <code className="mono">{setup.secret}</code>
          </p>
          <label>
            Code from the app
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern="[0-9 ]{6,7}" autoFocus />
          </label>
          <label>
            Your password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <ErrorNote error={a.error} />
          <div className="row gap">
            <button className="btn primary" disabled={a.busy}>
              Verify &amp; enable
            </button>
            <button type="button" className="btn ghost" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote error={a.error} />
          <button className="btn" onClick={start} disabled={a.busy}>
            {a.busy ? <Spinner size={16} /> : 'Enable 2FA'}
          </button>
        </>
      )}
    </Section>
  );
}

function TotpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { state } = useAppState();
  if (!state?.totpEnabled) return null;
  return (
    <label>
      Authentication code
      <input inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => onChange(e.target.value)} required pattern="[0-9 ]{6,7}" />
    </label>
  );
}

function RecoverySection() {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await a.run(async () => {
      setKey((await api.rotateRecoveryKey(password, totp.trim() || undefined)).recoveryKey);
      setPassword('');
      setTotp('');
    });
  };
  return (
    <Section id="recovery" title="Recovery key">
      <p className="muted">Creates a new recovery key and invalidates the old one. Store the new key safely — it is shown only once.</p>
      {key ? (
        <>
          <RecoveryKeyBox recoveryKey={key} />
          <button className="btn" onClick={() => setKey(null)}>
            I have saved it
          </button>
        </>
      ) : (
        <form className="form narrow" onSubmit={submit}>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <TotpField value={totp} onChange={setTotp} />
          <ErrorNote error={a.error} />
          <button className="btn" disabled={a.busy}>
            Generate new recovery key
          </button>
        </form>
      )}
    </Section>
  );
}

function SessionsSection() {
  const { refresh } = useAppState();
  const navigate = useNavigate();
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const a = useAsync();
  const load = useCallback(() => api.sessions().then(setList, () => setList([])), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Section id="sessions" title="Sessions">
      <ErrorNote error={a.error} />
      {!list ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>IP</th>
                <th>Last active</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="ua">
                    {s.current ? <span className="badge green">this device</span> : null} {s.userAgent ?? 'Unknown'}
                  </td>
                  <td className="mono small">{s.ip ?? '—'}</td>
                  <td>{formatDateTime(s.lastSeenAt)}</td>
                  <td>{formatDateTime(s.expiresAt)}</td>
                  <td>
                    <button
                      className="btn tiny ghost"
                      onClick={() =>
                        a.run(async () => {
                          await api.revokeSession(s.id);
                          if (s.current) {
                            await refresh();
                            navigate('/login');
                          } else await load();
                        })
                      }
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmButton
        className="btn"
        confirmLabel="Log out all sessions"
        onConfirm={() =>
          a.run(async () => {
            await api.logoutAll();
            await refresh();
            navigate('/login');
          })
        }
      >
        Log out everywhere
      </ConfirmButton>
    </Section>
  );
}

function LoggingSection() {
  const [s, setS] = useState<Settings | null>(null);
  const a = useAsync();
  useEffect(() => {
    api.settings().then(setS, () => undefined);
  }, []);
  if (!s) return <Spinner />;
  const save = (patch: Partial<Settings>) => a.run(async () => setS(await api.updateSettings(patch)), 'Saved.');
  return (
    <Section id="logging" title="Logging">
      <label className="check">
        <input type="checkbox" checked={s.downloadHistoryMedia} onChange={(e) => save({ downloadHistoryMedia: e.target.checked })} /> Download media of imported history (not only new messages)
      </label>
      <label className="check">
        <input type="checkbox" checked={!!s.readReceipts} onChange={(e) => save({ readReceipts: e.target.checked })} /> Mark chats as seen on Instagram when I open them here (senders see “Seen”)
      </label>
      <div className="form narrow">
        <label>
          Maximum media size to download (MB)
          <input type="number" min={1} max={2000} defaultValue={s.mediaMaxMb} onBlur={(e) => Number(e.target.value) !== s.mediaMaxMb && save({ mediaMaxMb: Number(e.target.value) })} />
        </label>
        <label>
          Messages to import per chat on first login
          <input
            type="number"
            min={0}
            max={2000}
            defaultValue={s.historyPerChat}
            onBlur={(e) => Number(e.target.value) !== s.historyPerChat && save({ historyPerChat: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="muted small">View-once photos and videos are never logged. The history import pauses between requests to Instagram, so a big inbox takes a while.</p>
      <label className="check">
        <input type="checkbox" checked={s.sessionRefresh} onChange={(e) => save({ sessionRefresh: e.target.checked })} /> Refresh the Instagram session in the background regularly
      </label>
      <div className="form narrow">
        <label>
          Every (hours)
          <input
            type="number"
            min={1}
            max={24}
            disabled={!s.sessionRefresh}
            defaultValue={s.sessionRefreshHours}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 24 && v !== s.sessionRefreshHours) save({ sessionRefreshHours: v });
            }}
          />
        </label>
      </div>
      <p className="muted small">
        Reloads the background Instagram tab like a person coming back to it. Each time is randomly up to 10 minutes earlier or later than the
        interval, so it never happens on an exact schedule.
      </p>

      <h3 className="settings-sub">Stories</h3>
      <label className="check">
        <input type="checkbox" checked={s.storyLogging} onChange={(e) => save({ storyLogging: e.target.checked })} /> Log the stories of the accounts I follow
      </label>
      <div className="form narrow">
        <label>
          Keep stories for (days)
          <input
            type="number"
            min={1}
            max={3650}
            defaultValue={s.storyRetentionDays}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 3650 && v !== s.storyRetentionDays) save({ storyRetentionDays: v });
            }}
          />
        </label>
      </div>
      <p className="muted small">
        Checks for new stories about every 45 minutes (at random times) and saves them encrypted on your server. Stories are never marked as
        seen. Stories older than the number of days above are deleted, also when story logging is off.
      </p>
      <ErrorNote error={a.error} />
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
    </Section>
  );
}

function InstagramSection() {
  const { ig } = useAppState();
  const a = useAsync();
  return (
    <Section id="instagram" title="Instagram connection">
      <div className="row gap wrap">
        <IgStatePill status={ig} />
        <span className="muted small">{ig?.detail}</span>
        {ig?.me ? <span className="small">Logged in: {ig.me.name} {ig.me.username ? `@${ig.me.username}` : ''}</span> : null}
        <span className="muted small">Media queue: {ig?.mediaQueue ?? 0}</span>
        <span className="muted small">Last live update: {ig?.lastEventAt ? formatDateTime(ig.lastEventAt) : '—'}</span>
      </div>
      <div className="row gap">
        <button className="btn" onClick={() => a.run(api.igRestart, 'Restarting…')} disabled={a.busy}>
          <Icon name="refresh" size={16} /> Reload Instagram
        </button>
        <ConfirmButton className="btn" confirmLabel="Log Instagram out" onConfirm={() => void a.run(api.igLogout, 'Logged out of Instagram.')}>
          Log the browser out of Instagram
        </ConfirmButton>
      </div>
      <ErrorNote error={a.error} />
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
    </Section>
  );
}

function AuditSection() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.audit().then(setRows, () => setRows([]));
  }, []);
  return (
    <Section id="audit" title="Security log">
      {!rows ? (
        <Spinner />
      ) : (
        <div className="table-wrap audit">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={/fail|wipe|revoked|logout/.test(r.event) ? 'warn-row' : undefined}>
                  <td>{formatDateTime(r.ts)}</td>
                  <td className="mono small">{r.event}</td>
                  <td className="mono small">{r.ip ?? '—'}</td>
                  <td className="small">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function DangerSection() {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [armed, setArmed] = useState(false);
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!armed) return setArmed(true);
    if (await a.run(() => api.wipe(password, totp.trim() || undefined), 'All logged messages and media were deleted.')) {
      setPassword('');
      setTotp('');
      setArmed(false);
    }
  };
  return (
    <Section id="danger" title="Danger zone" danger>
      <p className="muted">Permanently deletes every logged message, edit, reaction and media file. Your account and the Instagram login stay; logging continues for new messages.</p>
      <form className="form narrow" onSubmit={submit}>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <TotpField value={totp} onChange={setTotp} />
        <ErrorNote error={a.error} />
        {a.ok ? <p className="ok-note">{a.ok}</p> : null}
        <div className="row gap">
          <button className="btn danger" disabled={a.busy}>
            {armed ? 'Click again to wipe everything' : 'Wipe all logged data'}
          </button>
          {armed ? (
            <button type="button" className="btn ghost" onClick={() => setArmed(false)}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

export function SettingsPage() {
  const { state } = useAppState();
  return (
    <div className="page settings">
      <header className="page-head">
        <h1>
          <Icon name="settings" /> Settings
        </h1>
        <p className="muted">Signed in as {state?.username}</p>
        <nav className="toc">
          {[
            ['password', 'Password'],
            ['2fa', '2FA'],
            ['recovery', 'Recovery key'],
            ['sessions', 'Sessions'],
            ['logging', 'Logging'],
            ['instagram', 'Instagram'],
            ['audit', 'Security log'],
            ['danger', 'Danger zone'],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <PasswordSection />
      <TotpSection />
      <RecoverySection />
      <SessionsSection />
      <LoggingSection />
      <InstagramSection />
      <AuditSection />
      <DangerSection />
    </div>
  );
}
