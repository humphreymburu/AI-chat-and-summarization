import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ padding: "4rem 1rem", textAlign: "center" }}>
      <h1>404 - Page Not Found</h1>
      <p>
        <Link href="/search">Go to search</Link>
      </p>
    </main>
  );
}
