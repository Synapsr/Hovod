import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { setToken } from '../lib/auth.js';
import { useT } from '../lib/i18n/index.js';
import { AuthError, AuthField, AuthShell, AuthSubmit } from '../components/AuthShell.js';
import type { InvitePreview } from '../lib/types.js';

/**
 * `/invite/:token` — public. Shows which organization is inviting, then either
 * creates the account (name + password) or simply joins with the existing one.
 */
export function InvitePage() {
  const { t } = useT();
  const navigate = useNavigate();
  const { token = '' } = useParams();

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { data: invite, isLoading, isError } = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitePreview>(`/v1/invitations/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

  const accept = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const body: Record<string, string> = {};
      if (invite?.requiresSignup) {
        body.name = name;
        body.password = password;
      }
      const data = await api<{ token: string }>(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setToken(data.token);
      navigate('/videos', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.invite.failedAccept);
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <Link to="/login" className="text-accent-400 hover:text-accent-500 transition-colors font-medium">
      {t.password.backToSignIn}
    </Link>
  );

  if (isLoading) {
    return (
      <AuthShell title={t.invite.title}>
        <p className="text-sm text-zinc-500 text-center" aria-busy="true">{t.invite.loading}</p>
      </AuthShell>
    );
  }

  if (isError || !invite) {
    return (
      <AuthShell title={t.invite.title} footer={footer}>
        <p className="text-sm text-zinc-400 text-center" data-testid="invite-invalid">{t.invite.invalid}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t.invite.joinOrg.replace('{org}', invite.orgName)}
      subtitle={invite.requiresSignup ? t.invite.createAccountHint : t.invite.signInHint}
      footer={footer}
    >
      <form onSubmit={accept} className="space-y-3" data-testid="invite-form">
        <p className="text-xs text-zinc-500 bg-zinc-800/40 border border-zinc-800/60 rounded-lg px-3 py-2">
          {t.invite.invitedAs.replace('{email}', invite.email)}
        </p>

        {invite.requiresSignup && (
          <>
            <AuthField
              id="name"
              label={t.auth.name}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              placeholder={t.auth.yourName}
            />
            <AuthField
              id="password"
              label={t.auth.password}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder={t.auth.minChars}
            />
          </>
        )}

        {error && <AuthError message={error} />}

        <AuthSubmit disabled={loading}>{loading ? t.invite.accepting : t.invite.accept}</AuthSubmit>
      </form>
    </AuthShell>
  );
}
