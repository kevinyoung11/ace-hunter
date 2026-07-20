"use client";
import { useState } from "react";
import { createSupabaseBrowserClient } from "../../lib/web/supabase-browser";
export default function LoginPage() { const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); return <main className="login"><section><p>ACE HUNTER</p><h1>登录</h1><form onSubmit={async (event) => { event.preventDefault(); await createSupabaseBrowserClient().auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/auth/callback` } }); setSent(true); }}><label htmlFor="email">邮箱</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /><button>发送登录链接</button></form>{sent ? <p className="message">登录链接已发送，请在邮箱中打开。</p> : null}</section></main>; }
