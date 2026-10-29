"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { signOut, useSession } from "@unep/lib/auth-client";

const LINKS = [
  {
    href: "/chat",
    label: "Chat",
    icon: <path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-3.9A8 8 0 1 1 20 12Z" />,
  },
  {
    href: "/summary",
    label: "Summary",
    icon: <path d="M6 3h9l4 4v14H6V3Zm8 0v5h5M9 13h7M9 17h7M9 9h2" />,
  },
];

interface AppShellProps {
  children: ReactNode;
  /** Saved conversations, rendered between the nav and the account (Chat only). */
  history?: ReactNode;
  /** Called by "New chat" when already on /chat; otherwise it links there. */
  onNewChat?: () => void;
  /** false lets the page manage its own scrolling (Chat). */
  scroll?: boolean;
  /**
   * Server's guess from the login cookie. false = guest for certain, so the
   * guest layout shows at once; true = show the signed-in layout as a
   * skeleton while the session loads. Unset = unknown.
   */
  signedIn?: boolean;
}

export default function AppShell({
  children,
  history,
  onNewChat,
  scroll = true,
  signedIn,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  // The drawer is open only for the page it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((cur) =>
      (typeof next === "function" ? next(cur === pathname) : next)
        ? pathname
        : null
    );
  const user = session?.user;

  const handleLogout = async () => {
    await signOut();
    router.push("/chat");
    router.refresh();
  };

  const newChat = onNewChat ? (
    <button
      type="button"
      className="kb-side-new"
      onClick={() => {
        onNewChat();
        setOpen(false);
      }}
    >
      <PlusIcon /> New chat
    </button>
  ) : (
    <Link href="/chat" className="kb-side-new">
      <PlusIcon /> New chat
    </Link>
  );

  // Waiting for the session of someone who is probably signed in.
  const memberPending = !user && isPending && signedIn === true;
  // Guest nav is safe to show once we know there's no session.
  const guestKnown = !isPending || signedIn === false;

  if (!user && !memberPending) {
    return (
      <div className="kb-root kb-calm kb-shell kb-shell-guest">
        <header className="kb-guestbar">
          <Link href="/chat" className="kb-brand">
            <Image
              src="/ecobuddy-logo-icon.png"
              alt=""
              width={28}
              height={28}
              className="kb-logo"
              priority
            />
            EcoBuddy
          </Link>
          {guestKnown ? (
            <nav className="kb-guestbar-nav" aria-label="Main">
              {LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={`kb-side-link${
                    pathname === href ? " active" : ""
                  }`}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  {label}
                </Link>
              ))}
              <Link href="/login" className="kb-side-quiet">
                Log in
              </Link>
              <Link href="/signup" className="kb-side-signup">
                Sign up
              </Link>
            </nav>
          ) : (
            <div className="kb-guestbar-nav" aria-hidden="true">
              <span className="kb-skeleton kb-skel-pill" />
              <span className="kb-skeleton kb-skel-pill" />
              <span className="kb-skeleton kb-skel-pill kb-skel-pill-wide" />
            </div>
          )}
        </header>
        <main className={`kb-main${scroll ? "" : " kb-main-fixed"}`}>
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="kb-root kb-calm kb-shell">
      <header className="kb-topbar">
        <button
          type="button"
          className="kb-topbar-menu"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="kb-sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          <MenuIcon />
        </button>
        <span className="kb-brand kb-topbar-brand">
          <Image
            src="/ecobuddy-logo-icon.png"
            alt=""
            width={28}
            height={28}
            className="kb-logo"
            priority
          />
          EcoBuddy
        </span>
      </header>
      {open && (
        <button
          type="button"
          className="kb-scrim"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
        />
      )}
      <aside id="kb-sidebar" className={`kb-sidebar${open ? " open" : ""}`}>
        <Link href="/chat" className="kb-brand kb-sidebar-brand">
          <Image
            src="/ecobuddy-logo-icon.png"
            alt=""
            width={28}
            height={28}
            className="kb-logo"
            priority
          />
          EcoBuddy
        </Link>
        {newChat}
        <p className="kb-side-label">Menu</p>
        <nav className="kb-side-nav" aria-label="Main">
          {LINKS.map(({ href, label, icon }) => (
            <Link
              key={href}
              href={href}
              className={`kb-side-link${pathname === href ? " active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {icon}
              </svg>
              {label}
            </Link>
          ))}
        </nav>
        <div className="kb-side-history">{history}</div>
        <div className="kb-side-account">
          {!user ? (
            <span
              className="kb-side-user"
              role="status"
              aria-label="Loading your account"
            >
              <span className="kb-skeleton kb-skel-avatar" aria-hidden="true" />
              <span className="kb-skel-stack" aria-hidden="true">
                <span className="kb-skeleton kb-skel-line" />
                <span className="kb-skeleton kb-skel-line kb-skel-sm" />
              </span>
            </span>
          ) : (
            <>
              <span className="kb-side-user" title={user.email}>
                <span className="kb-nav-avatar" aria-hidden="true">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <span className="kb-side-user-text">
                  <span className="kb-side-user-name">
                    {user.name || user.email}
                  </span>
                  <span className="kb-side-user-email">{user.email}</span>
                </span>
              </span>
              <button
                type="button"
                className="kb-side-quiet"
                onClick={handleLogout}
              >
                Log out
              </button>
            </>
          )}
        </div>
      </aside>
      <main className={`kb-main${scroll ? "" : " kb-main-fixed"}`}>
        {children}
      </main>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 6h14M3 10h14M3 14h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
