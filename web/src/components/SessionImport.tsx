import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { ErrorNote, Spinner } from './ui';

/**
 * Logging in with the session of the owner's own browser, for when Instagram's login keeps asking the server's browser
 * for a captcha. The pasted text is a credential: it is sent once and cleared, never stored in the page.
 */
export function SessionImport({ open = false }: { open?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.igImportSession(text);
      setText('');
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="session-import" open={open}>
      <summary>Captcha keeps coming back? Log in with your own browser instead</summary>
      <ol className="steps small">
        <li>
          On your computer, open a <b>private window</b> (Chrome: Ctrl+Shift+N, Firefox: Ctrl+Shift+P), go to instagram.com and log in.
        </li>
        <li>
          Press <b>F12</b>, open the <b>Network</b> tab and reload the page (<b>F5</b>).
        </li>
        <li>
          Right-click the first request (<code>www.instagram.com</code>) → <b>Copy</b> → <b>Copy as cURL</b> (on Windows: <b>Copy as cURL (bash)</b>).
        </li>
        <li>
          Paste it below and press <b>Use this login</b>.
        </li>
        <li>
          Then <b>close the private window without logging out</b>: logging out there would end this login too.
        </li>
      </ol>
      <form onSubmit={submit} className="form">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Copied request"
          placeholder="curl 'https://www.instagram.com/' -H … -b 'csrftoken=…; ds_user_id=…; sessionid=…'"
        />
        <p className="muted small">
          This is your Instagram login. insta_logger only takes the Instagram cookies from it, puts them into its own browser and never logs
          them.
        </p>
        <ErrorNote error={error} />
        {done ? <p className="ok-note small">Login handed over. The status changes to Connected once Instagram accepts it.</p> : null}
        <div className="row gap">
          <button className="btn primary" disabled={busy || !text.trim()}>
            {busy ? <Spinner size={18} /> : 'Use this login'}
          </button>
        </div>
      </form>
    </details>
  );
}
