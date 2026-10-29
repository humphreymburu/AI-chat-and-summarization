"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signIn, signUp } from "@unep/lib/auth-client";

type Mode = "login" | "signup";

export default function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isSignup = mode === "signup";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: authError } = isSignup
      ? await signUp.email({ name: name.trim(), email, password })
      : await signIn.email({ email, password });
    setPending(false);
    if (authError) {
      setError(authError.message ?? "Something went wrong. Please try again.");
      return;
    }
    router.push("/chat");
    router.refresh();
  };

  return (
    <div className="kb-auth-card">
      <Link href="/chat" className="kb-brand kb-auth-logo">
        <Image
          src="/ecobuddy-logo-icon.png"
          alt=""
          width={28}
          height={28}
          className="kb-logo"
        />
        EcoBuddy
      </Link>
      <h1 className="kb-auth-title">
        {isSignup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="kb-auth-sub">
        {isSignup
          ? "Save your conversations and pick up where you left off."
          : "Log in to see your saved conversations."}
      </p>

      <form className="kb-auth-form" onSubmit={handleSubmit}>
        {isSignup && (
          <label className="kb-auth-field">
            <span>Name</span>
            <input
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label className="kb-auth-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="kb-auth-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isSignup && <small>At least 8 characters.</small>}
        </label>

        {error && (
          <div className="kb-auth-error" role="alert">
            {error}
          </div>
        )}

        <button className="kb-auth-submit" type="submit" disabled={pending}>
          {pending
            ? isSignup
              ? "Creating account…"
              : "Logging in…"
            : isSignup
            ? "Sign up"
            : "Log in"}
        </button>
      </form>

      <p className="kb-auth-switch">
        {isSignup ? "Already have an account? " : "New here? "}
        <Link href={isSignup ? "/login" : "/signup"}>
          {isSignup ? "Log in" : "Create an account"}
        </Link>
      </p>
      <p className="kb-auth-switch">
        <Link href="/chat">Continue without an account</Link>
      </p>
    </div>
  );
}
