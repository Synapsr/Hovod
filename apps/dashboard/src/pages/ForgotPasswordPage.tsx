import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useServerConfig } from '../lib/server-config.js';
import { useT } from '../lib/i18n/index.js';
import { AuthError, AuthField, AuthShell, AuthSubmit } from '../components/AuthShell.js';

/**
 * `/forgot-password` — available in both modes. The API always answers 200 so the
 * page can never be used to probe which addresses have an account.
 */
export function ForgotPasswordPage() {
  const { t } = useT();
  const { emailEnabled } = useServerConfig();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api('/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <Link to="/login" className="text-accent-400 hover:text-accent-500 transition-colors font-medium">
      {t.password.backToSignIn}
    </Link>
  );

  if (sent) {
    return (
      <AuthShell title={t.password.sentTitle} footer={footer}>
        <p className="text-sm text-zinc-400 text-center" data-testid="forgot-sent">
          {t.password.sentBody.replace('{email}', email)}
        </p>
        {!emailEnabled && <CliHint />}
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.password.forgotTitle} subtitle={t.password.forgotBody} footer={footer}>
      <form onSubmit={submit} className="space-y-3">
        <AuthField
          id="email"
          label={t.auth.email}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder={t.auth.emailPlaceholder}
        />
        {error && <AuthError message={error} />}
        <AuthSubmit disabled={loading}>{loading ? t.password.sending : t.password.sendLink}</AuthSubmit>
      </form>
      {!emailEnabled && <CliHint />}
    </AuthShell>
  );
}

/** Self-hosters without Resend configured get the CLI fallback instead of a dead end. */
function CliHint() {
  const { t } = useT();
  return (
    <div className="mt-5 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5" data-testid="reset-cli-hint">
      <p className="text-xs font-medium text-zinc-400">{t.password.noEmailTitle}</p>
      <p className="text-[11px] text-zinc-600 mt-1 leading-relaxed break-words">{t.password.noEmailHint}</p>
    </div>
  );
}
