"use client";

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { isProductionAuth } from "./auth-mode";
import { BrandMark, Icon, type IconName } from "./ui";

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/collection", label: "Collection", icon: "collection" },
  { href: "/wishlist", label: "Wishlist", icon: "heart" },
];

function useDisplayName() {
  const clerkUser = isProductionAuth ? useClerkDisplayName() : null;
  return clerkUser ?? "Development user";
}

function useClerkDisplayName() {
  const { user } = useUser();
  return user?.fullName ?? user?.username ?? null;
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const displayName = toDisplayName(useDisplayName());
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="sidebar__brand" href="/dashboard">
          <BrandMark compact />
          <span>VinylHound</span>
        </Link>

        <Link className="scan-button" href="/scan">
          <span className="scan-button__icon">
            <Icon name="camera" size={21} />
          </span>
          <span>
            <strong>Scan a record</strong>
            <small>Camera or upload</small>
          </span>
          <Icon name="chevronRight" size={18} />
        </Link>

        <nav className="sidebar__nav" aria-label="Main navigation">
          <p>Library</p>
          {navigation.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                className={active ? "is-active" : ""}
                href={item.href}
                key={item.href}
              >
                <Icon name={item.icon} size={20} />
                <span>{item.label}</span>
                {item.label === "Collection" ? <small>48</small> : null}
                {item.label === "Wishlist" ? <small>12</small> : null}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <Link
            className={pathname === "/account" ? "is-active" : ""}
            href="/account"
          >
            <span className="avatar">{initials}</span>
            <span className="account-summary">
              <strong>{displayName}</strong>
              <small>View account</small>
            </span>
            <Icon name="chevronRight" size={17} />
          </Link>
        </div>
      </aside>

      <header className="mobile-header">
        <Link className="mobile-header__brand" href="/dashboard">
          <BrandMark compact />
          <span>VinylHound</span>
        </Link>
        <Link aria-label="Account details" className="avatar" href="/account">
          {initials}
        </Link>
      </header>

      <div className="app-content">{children}</div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link
          className={pathname === "/dashboard" ? "is-active" : ""}
          href="/dashboard"
        >
          <Icon name="home" />
          <span>Home</span>
        </Link>
        <Link
          className={pathname === "/collection" ? "is-active" : ""}
          href="/collection"
        >
          <Icon name="collection" />
          <span>Collection</span>
        </Link>
        <Link
          className="mobile-nav__scan"
          href="/scan"
          aria-label="Scan a record"
        >
          <span>
            <Icon name="camera" size={23} />
          </span>
          <small>Scan</small>
        </Link>
        <Link
          className={pathname === "/wishlist" ? "is-active" : ""}
          href="/wishlist"
        >
          <Icon name="heart" />
          <span>Wishlist</span>
        </Link>
        <Link
          className={pathname === "/account" ? "is-active" : ""}
          href="/account"
        >
          <Icon name="account" />
          <span>Account</span>
        </Link>
      </nav>
    </div>
  );
}

function toDisplayName(name: string) {
  return name
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
