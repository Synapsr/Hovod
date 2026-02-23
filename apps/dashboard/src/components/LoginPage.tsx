import { useState } from 'react';
import { api } from '../lib/api.js';
import { setToken } from '../lib/auth.js';
import { useT } from '../lib/i18n/index.js';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { t } = useT();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = mode === 'signup' ? '/v1/auth/signup' : '/v1/auth/login';
      const body =
        mode === 'signup'
          ? JSON.stringify({ email, password, name })
          : JSON.stringify({ email, password });

      const data = await api<{ token: string }>(endpoint, { method: 'POST', body });
      setToken(data.token);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-accent-600 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
                <path d="M3 1v12l9.5-6z" />
              </svg>
            </div>
            <span className="text-lg font-semibold tracking-tight text-zinc-50">
              Hovod
            </span>
          </div>
        </div>

        {/* Card */}
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl p-6">
          <h1 className="text-lg font-semibold text-zinc-50 text-center mb-1">
            {mode === 'login' ? t.auth.signIn : t.auth.createYourAccount}
          </h1>
          <p className="text-sm text-zinc-500 text-center mb-6">
            {mode === 'login'
              ? t.auth.enterCredentials
              : t.auth.startManaging}
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'signup' && (
              <div>
                <label
                  htmlFor="name"
                  className="block text-xs font-medium text-zinc-400 mb-1.5"
                >
                  {t.auth.name}
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                  className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
                  placeholder={t.auth.yourName}
                />
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-xs font-medium text-zinc-400 mb-1.5"
              >
                {t.auth.email}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
                placeholder={t.auth.emailPlaceholder}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium text-zinc-400 mb-1.5"
              >
                {t.auth.password}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={
                  mode === 'login' ? 'current-password' : 'new-password'
                }
                className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
                placeholder={
                  mode === 'signup' ? t.auth.minChars : t.auth.yourPassword
                }
              />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-1"
            >
              {loading
                ? mode === 'login'
                  ? t.auth.signingIn
                  : t.auth.creatingAccount
                : mode === 'login'
                  ? t.auth.signIn
                  : t.auth.createAccount}
            </button>
          </form>
        </div>

        {/* Toggle */}
        <p className="text-center text-sm text-zinc-500 mt-5">
          {mode === 'login' ? (
            <>
              {t.auth.noAccount}{' '}
              <button
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
                className="text-accent-400 hover:text-accent-500 transition-colors font-medium"
              >
                {t.auth.signUp}
              </button>
            </>
          ) : (
            <>
              {t.auth.haveAccount}{' '}
              <button
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
                className="text-accent-400 hover:text-accent-500 transition-colors font-medium"
              >
                {t.auth.signIn}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
