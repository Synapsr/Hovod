import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { getUser } from '../lib/auth.js';
import { timeAgo } from '../lib/helpers.js';
import { useT } from '../lib/i18n/index.js';
import type { Translations } from '../lib/i18n/index.js';
import type { OrgMember } from '../lib/types.js';

/* ─── Role Helpers ───────────────────────────────────────── */

const ROLE_STYLE: Record<string, string> = {
  owner:  'text-amber-400 bg-amber-500/10 border-amber-500/20',
  admin:  'text-accent-400 bg-accent-600/10 border-accent-500/20',
  member: 'text-zinc-400 bg-zinc-800 border-zinc-700/60',
};

function RoleBadge({ role, t }: { role: string; t: Translations }) {
  const className = ROLE_STYLE[role] ?? ROLE_STYLE.member!;
  const labels: Record<string, string> = {
    owner: t.members.owner,
    admin: t.members.admin,
    member: t.members.member,
  };
  const label = labels[role] ?? labels.member;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md border ${className}`}>
      {label}
    </span>
  );
}

function MemberAvatar({ name, email }: { name: string | null; email: string }) {
  const initial = (name ?? email).charAt(0).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full bg-accent-600/20 border border-accent-500/30 flex items-center justify-center shrink-0">
      <span className="text-xs font-semibold text-accent-400">{initial}</span>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function MembersPage() {
  const { t } = useT();
  const currentUser = getUser();
  const orgId = currentUser?.org;

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Current user's role in this org (determined from the member list)
  const [myRole, setMyRole] = useState<string>('member');

  // Add member dialog
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<'admin' | 'member'>('member');
  const [adding, setAdding] = useState(false);

  // Remove confirmation
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
  const [removing, setRemoving] = useState(false);

  // Role change
  const [roleMenuOpen, setRoleMenuOpen] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState(false);

  const canManage = myRole === 'owner' || myRole === 'admin';

  const roleLabels: Record<string, string> = {
    owner: t.members.owner,
    admin: t.members.admin,
    member: t.members.member,
  };

  const fetchMembers = useCallback(async () => {
    if (!orgId) return;
    try {
      const data = await api<OrgMember[]>(`/v1/orgs/${orgId}/members`);
      setMembers(data);

      // Determine the current user's role
      const me = data.find((m) => m.userId === currentUser?.sub);
      if (me) setMyRole(me.role);
    } catch {
      setError(t.members.failedLoad);
    } finally {
      setLoading(false);
    }
  }, [orgId, currentUser?.sub]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  // Close role dropdown when clicking outside
  useEffect(() => {
    if (!roleMenuOpen) return;
    const close = () => setRoleMenuOpen(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [roleMenuOpen]);

  const addMember = async () => {
    if (!orgId || !addEmail.trim()) return;
    setAdding(true);
    setError('');
    try {
      await api(`/v1/orgs/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: addEmail.trim(), role: addRole }),
      });
      setAddEmail('');
      setAddRole('member');
      setShowAdd(false);
      await fetchMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.members.failedAdd);
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (memberId: string) => {
    if (!orgId) return;
    setRemoving(true);
    setError('');
    try {
      await api(`/v1/orgs/${orgId}/members/${memberId}`, { method: 'DELETE' });
      setRemoveTarget(null);
      await fetchMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.members.failedRemove);
    } finally {
      setRemoving(false);
    }
  };

  const changeRole = async (memberId: string, newRole: string) => {
    if (!orgId) return;
    setChangingRole(true);
    setError('');
    try {
      await api(`/v1/orgs/${orgId}/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      setRoleMenuOpen(null);
      await fetchMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.members.failedChangeRole);
    } finally {
      setChangingRole(false);
    }
  };

  /* Loading skeleton */
  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="h-6 w-32 bg-zinc-800 rounded animate-pulse" />
            <div className="h-4 w-48 bg-zinc-800/60 rounded animate-pulse mt-2" />
          </div>
          <div className="h-9 w-32 bg-zinc-800 rounded-lg animate-pulse" />
        </div>
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-4 border-b border-zinc-800/20 last:border-b-0 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-zinc-800" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 bg-zinc-800 rounded" />
                <div className="h-3 w-48 bg-zinc-800/60 rounded" />
              </div>
              <div className="h-5 w-16 bg-zinc-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-zinc-50">{t.members.title}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {t.members.subtitle.replace('{count}', String(members.length))}
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowAdd(true)}
            className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors flex items-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t.members.addMember}
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-6">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-400 ml-3">{t.common.dismiss}</button>
        </div>
      )}

      {/* Members list — Desktop */}
      <div className="hidden sm:block bg-zinc-900/60 border border-zinc-800/60 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_100px_80px] px-5 py-3 border-b border-zinc-800/40 bg-zinc-900/40">
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.members.member}</span>
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.members.role}</span>
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.members.joined}</span>
          <span />
        </div>
        {members.map((member) => {
          const isOwner = member.role === 'owner';
          const isMe = member.userId === currentUser?.sub;

          return (
            <div
              key={member.id}
              className="grid grid-cols-[1fr_100px_100px_80px] items-center px-5 py-3 border-b border-zinc-800/20 last:border-b-0 hover:bg-zinc-800/20 transition-colors"
            >
              {/* User info */}
              <div className="flex items-center gap-3 min-w-0">
                <MemberAvatar name={member.name} email={member.email} />
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">
                    {member.name ?? member.email.split('@')[0]}
                    {isMe && <span className="text-zinc-600 ml-1.5">{t.common.you}</span>}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">{member.email}</p>
                </div>
              </div>

              {/* Role badge with optional dropdown */}
              <div className="relative">
                {canManage && !isOwner && !isMe ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); setRoleMenuOpen(roleMenuOpen === member.id ? null : member.id); }}
                    className="group flex items-center gap-1"
                    disabled={changingRole}
                  >
                    <RoleBadge role={member.role} t={t} />
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                ) : (
                  <RoleBadge role={member.role} t={t} />
                )}

                {/* Role dropdown */}
                {roleMenuOpen === member.id && (
                  <div className="absolute z-20 top-full left-0 mt-1 w-32 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl overflow-hidden">
                    {['admin', 'member'].map((role) => (
                      <button
                        key={role}
                        onClick={(e) => { e.stopPropagation(); changeRole(member.id, role); }}
                        disabled={changingRole || member.role === role}
                        className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                          member.role === role
                            ? 'text-zinc-600 cursor-default'
                            : 'text-zinc-300 hover:bg-zinc-800'
                        }`}
                      >
                        {roleLabels[role] ?? role}
                        {member.role === role && <span className="text-zinc-700 ml-1">{t.common.current}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Join date */}
              <span className="text-xs text-zinc-500">{timeAgo(member.joinedAt, t.time)}</span>

              {/* Actions */}
              <div className="text-right">
                {canManage && !isOwner && !isMe && (
                  <button
                    onClick={() => setRemoveTarget(member)}
                    className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
                  >
                    {t.common.remove}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Members list — Mobile */}
      <div className="sm:hidden space-y-3">
        {members.map((member) => {
          const isOwner = member.role === 'owner';
          const isMe = member.userId === currentUser?.sub;

          return (
            <div key={member.id} className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
              <div className="flex items-start gap-3">
                <MemberAvatar name={member.name} email={member.email} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-zinc-200 truncate">
                      {member.name ?? member.email.split('@')[0]}
                      {isMe && <span className="text-zinc-600 ml-1">{t.common.you}</span>}
                    </p>
                    <RoleBadge role={member.role} t={t} />
                  </div>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{member.email}</p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[11px] text-zinc-600">{t.members.joined} {timeAgo(member.joinedAt, t.time)}</span>
                    {canManage && !isOwner && !isMe && (
                      <button
                        onClick={() => setRemoveTarget(member)}
                        className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
                      >
                        {t.common.remove}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── Add member dialog ─── */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
          onKeyDown={(e) => { if (e.key === 'Escape' && !adding) { setShowAdd(false); setAddEmail(''); setAddRole('member'); } }}
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!adding) { setShowAdd(false); setAddEmail(''); setAddRole('member'); } }} />
          <div
            className="relative z-10 w-full max-w-md mx-4 p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100 mb-1">{t.members.addMember}</h2>
            <p className="text-xs text-zinc-500 mb-5">
              {t.members.addMemberDesc}
            </p>

            <label className="text-xs font-medium text-zinc-400 block mb-1.5">{t.auth.email}</label>
            <input
              type="email"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addEmail.trim()) addMember(); }}
              placeholder={t.members.emailPlaceholder}
              autoFocus
              className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
              disabled={adding}
            />

            <label className="text-xs font-medium text-zinc-400 block mt-4 mb-1.5">{t.members.role}</label>
            <div className="flex gap-2">
              {(['member', 'admin'] as const).map((role) => (
                <button
                  key={role}
                  onClick={() => setAddRole(role)}
                  disabled={adding || (role === 'admin' && myRole !== 'owner')}
                  className={`flex-1 h-10 text-sm font-medium rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    addRole === role
                      ? 'bg-accent-600/20 border-accent-500/40 text-accent-400'
                      : 'bg-zinc-800/40 border-zinc-700/60 text-zinc-400 hover:text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {roleLabels[role] ?? role}
                </button>
              ))}
            </div>
            {myRole !== 'owner' && (
              <p className="text-[11px] text-zinc-600 mt-1.5">{t.members.onlyOwners}</p>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => { setShowAdd(false); setAddEmail(''); setAddRole('member'); }}
                disabled={adding}
                className="h-9 px-4 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={addMember}
                disabled={!addEmail.trim() || adding}
                className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {adding ? t.members.adding : t.members.addMember}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Remove confirmation dialog ─── */}
      {removeTarget && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
          onKeyDown={(e) => { if (e.key === 'Escape' && !removing) setRemoveTarget(null); }}
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!removing) setRemoveTarget(null); }} />
          <div
            className="relative z-10 w-full max-w-sm mx-4 p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="18" y1="8" x2="23" y2="13" />
                <line x1="23" y1="8" x2="18" y2="13" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-zinc-100 text-center mb-1">{t.members.removeMember}</h2>
            <p className="text-xs text-zinc-500 text-center mb-5">
              {t.members.removeConfirm.replace('{name}', removeTarget.name ?? removeTarget.email)}{' '}
              {t.members.removeWarning}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
                className="h-9 px-4 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={() => removeMember(removeTarget.id)}
                disabled={removing}
                className="h-9 px-4 text-sm font-medium rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40"
              >
                {removing ? t.members.removing : t.members.removeMember}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
