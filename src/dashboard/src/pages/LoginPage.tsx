import { useState, type FormEvent } from 'react';
import { Button } from '@/components/common/Button';
import { TextInput } from '@/components/common/TextInput';
import { useAuth } from '@/hooks/useAuth';

export function LoginPage() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await login(email, password);
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-950">
      <div className="w-full max-w-sm rounded-xl border border-navy-700/50 bg-navy-900 p-8 shadow-xl">
        {/* Logo */}
        <div className="mb-8 text-center">
          <img
            src="/assets/clutch-logo-white.png"
            alt="Clutch Group"
            className="mx-auto h-8"
          />
          <p className="mt-2 text-xs uppercase tracking-widest text-gray-500">
            Viewership Tracker
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Email
            </label>
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@clutch.game"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">
              Password
            </label>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
          </div>

          {error && (
            <p className="rounded bg-red-600/10 px-3 py-2 text-xs text-accent-red">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={submitting}
          >
            Sign In
          </Button>
        </form>
      </div>
    </div>
  );
}
