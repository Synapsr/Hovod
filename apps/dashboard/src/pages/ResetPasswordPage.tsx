import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';
import { AuthError, AuthField, AuthShell, AuthSubmit } from '../components/AuthShell.js';

/** `/reset-password/:token` — the link sent by email (or printed by the CLI). */
export function ResetPasswordPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(t.password.mismatch);
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api('/v1/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
      setDone(true);
    } catch (err) {
      // 400/404 means the token is spent or expired — say so instead of "request failed".
      if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 410)) {
        setError(t.password.invalidToken);
      } else {
        setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
      }
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <Link to="/login" className="text-accent-400 hover:text-accent-500 transition-colors font-medium">
      {t.password.backToSignIn}
    </Link>
  );

  if (done) {
    return (
      <AuthShell title={t.password.doneTitle} footer={footer}>
        <p className="text-sm text-zinc-400 text-center" data-testid="reset-done">{t.password.doneBody}</p>
        <button
          type="button"
          onClick={() => navigate('/login', { replace: true })}
          className="w-full h-10 mt-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors"
        >
          {t.auth.signIn}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.password.resetTitle} footer={footer}>
      <form onSubmit={submit} className="space-y-3">
        <AuthField
          id="password"
          label={t.password.newPassword}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder={t.auth.minChars}
        />
        <AuthField
          id="confirm"
          label={t.password.confirmPassword}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder={t.auth.minChars}
        />
        {error && <AuthError message={error} />}
        <AuthSubmit disabled={loading || !token}>
          {loading ? t.password.updating : t.password.updateCta}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
