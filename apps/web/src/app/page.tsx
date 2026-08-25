"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";

import { BrandMark, Icon } from "./ui";

type AuthMode = "signin" | "signup";

export default function AuthPage() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("collector@example.com");
  const [password, setPassword] = useState("vinylhound");
  const [name, setName] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const profileName = name.trim() || email.split("@")[0] || "Collector";
    window.localStorage.setItem(
      "vinylhound-demo-session",
      JSON.stringify({ name: profileName, email }),
    );
    window.location.assign("/dashboard");
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setName("");
  }

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="About VinylHound">
        <div className="auth-story__noise" aria-hidden="true" />
        <Link className="auth-brand" href="/" aria-label="VinylHound home">
          <BrandMark />
          <span>VinylHound</span>
        </Link>

        <div className="auth-story__copy">
          <span className="pill pill--light">For record people</span>
          <h1>Your collection has a story. Keep track of every chapter.</h1>
          <p>
            Scan a cover, identify the release, and keep your shelves and want
            list in one beautifully organized place.
          </p>
        </div>

        <div className="record-stack" aria-hidden="true">
          <div className="record-sleeve record-sleeve--back">
            <span>33⅓</span>
          </div>
          <div className="vinyl-disc">
            <div className="vinyl-disc__label">VH</div>
          </div>
          <div className="record-sleeve record-sleeve--front">
            <span className="record-sleeve__eyebrow">The late set</span>
            <strong>
              Blue
              <br />
              Hour
            </strong>
            <small>Sol Mercer Quartet</small>
          </div>
        </div>

        <p className="auth-story__quote">
          “The fastest way I’ve found to remember what I own—and what I’m still
          hunting for.”
        </p>
      </section>

      <section className="auth-panel">
        <div className="auth-panel__inner">
          <div className="auth-mobile-brand">
            <BrandMark />
            <span>VinylHound</span>
          </div>

          <div className="auth-heading">
            <p className="section-kicker">
              {mode === "signin" ? "Welcome back" : "Join the dig"}
            </p>
            <h2>
              {mode === "signin"
                ? "Pick up where you left off."
                : "Start your record story."}
            </h2>
            <p>
              {mode === "signin"
                ? "Sign in to see your recent scans and saved records."
                : "Create an account to scan, collect, and keep track of every find."}
            </p>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Account access">
            <button
              aria-selected={mode === "signin"}
              className={mode === "signin" ? "is-active" : ""}
              onClick={() => changeMode("signin")}
              role="tab"
              type="button"
            >
              Sign in
            </button>
            <button
              aria-selected={mode === "signup"}
              className={mode === "signup" ? "is-active" : ""}
              onClick={() => changeMode("signup")}
              role="tab"
              type="button"
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === "signup" ? (
              <label>
                <span>Name</span>
                <span className="input-shell">
                  <Icon name="user" size={19} />
                  <input
                    autoComplete="name"
                    onChange={(event) => setName(event.target.value)}
                    placeholder="How should we call you?"
                    required
                    value={name}
                  />
                </span>
              </label>
            ) : null}

            <label>
              <span>Email address</span>
              <span className="input-shell">
                <Icon name="mail" size={19} />
                <input
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  type="email"
                  value={email}
                />
              </span>
            </label>

            <label>
              <span className="label-row">
                Password
                {mode === "signin" ? (
                  <button type="button">Forgot?</button>
                ) : null}
              </span>
              <span className="input-shell">
                <Icon name="lock" size={19} />
                <input
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                  minLength={8}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  required
                  type={showPassword ? "text" : "password"}
                  value={password}
                />
                <button
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="input-action"
                  onClick={() => setShowPassword((visible) => !visible)}
                  type="button"
                >
                  <Icon name={showPassword ? "eyeOff" : "eye"} size={19} />
                </button>
              </span>
            </label>

            {mode === "signup" ? (
              <label className="checkbox-row">
                <input required type="checkbox" />
                <span>
                  I agree to the <a href="#terms">Terms</a> and{" "}
                  <a href="#privacy">Privacy Policy</a>.
                </span>
              </label>
            ) : null}

            <button className="primary-button auth-submit" type="submit">
              {mode === "signin" ? "Sign in" : "Create my account"}
              <Icon name="arrowRight" size={19} />
            </button>
          </form>

          <p className="demo-note">
            <Icon name="info" size={16} />
            Demo mode: use the prefilled details or create any sample account.
          </p>
        </div>
      </section>
    </main>
  );
}
