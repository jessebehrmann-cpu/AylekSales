import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-24 text-center">
      <p className="mb-3 text-sm font-medium uppercase tracking-wider text-primary">
        Aylek Sales
      </p>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
        AI-native fractional sales, run as a service.
      </h1>
      <p className="mt-6 max-w-xl text-base text-muted-foreground">
        Inbound handling, outbound sequences, pipeline CRM, and a queryable
        dashboard — closed-loop, industry-agnostic, gated behind an approved
        playbook for every client.
      </p>
      <div className="mt-10 flex items-center gap-4">
        <Link
          href="/login"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-6 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Create account
        </Link>
      </div>
    </main>
  );
}
