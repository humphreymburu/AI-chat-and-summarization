"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ padding: "4rem 1rem", textAlign: "center" }}>
      <h1>Something went wrong.</h1>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
