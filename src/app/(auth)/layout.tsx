export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-6 py-16">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
