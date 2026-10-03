"use client";
import Link from "next/link";
export default function CompanyError({ reset }: { reset: () => void }) {
  return <main className="intro"><h1>Could not load this company.</h1><p>Check the database connection and try again.</p><button className="button" onClick={reset}>Try again</button><p><Link href="/">← Back to company priorities</Link></p></main>;
}
