import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-950">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gray-400">404</h1>
        <p className="mt-2 text-lg text-gray-500">Page not found</p>
        <Link to="/" className="mt-4 inline-block text-sm text-accent-red hover:underline">
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
