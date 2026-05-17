async function sendTelegram(message, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const text = message.length > 4000 ? message.substring(0, 4000) + "\n...(truncated)" : message;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
    });
    if (!res.ok) console.error("[TG]", await res.text());
  } catch (err) {
    console.error("[TG]", err.message);
  }
}

async function notifyTrade(action, details, state, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  let msg;
  if (action === "OPEN") {
    const dir = (details.signal || details.direction || "").toUpperCase();
    const emoji = dir === "LONG" ? "🟢" : "🔴";
    msg = `${emoji} OPEN ${dir} ${details.symbol}\nEntry:$${details.price.toFixed(4)} SL:$${details.sl.toFixed(4)} TP:$${details.tp.toFixed(4)}\nScore:${details.score}\n[${(details.reasons || []).slice(0, 5).join(",")}]`;
  } else if (action === "PARTIAL") {
    msg = `📊 PARTIAL ${(details.direction || "").toUpperCase()} ${details.symbol}\n${((details.pct || 0) * 100).toFixed(0)}% closed @$${(details.exitPrice || 0).toFixed(4)}\n${details.reason}\nPnL:$${(details.pnl || 0).toFixed(2)}`;
  } else if (action === "DCA") {
    msg = `📉 DCA ${(details.direction || "").toUpperCase()} ${details.symbol}\n+50% @$${(details.price || 0).toFixed(4)} | Avg:$${(details.entryPrice || 0).toFixed(4)}\nMargin:$${(details.notional || 0).toFixed(2)}`;
  } else {
    const pnl = details.direction === "long"
      ? ((details.exitPrice || 0) - (details.entryPrice || 0)) * (details.size || 0)
      : ((details.entryPrice || 0) - (details.exitPrice || 0)) * (details.size || 0);
    const emoji = pnl >= 0 ? "💰" : "💸";
    msg = `${emoji} CLOSE ${(details.direction || "").toUpperCase()} ${details.symbol}\nExit:$${(details.exitPrice || 0).toFixed(4)} | ${details.exitReason || details.reason}\nPnL:$${pnl.toFixed(2)}`;
  }
  await sendTelegram(msg, env);
}

export { sendTelegram, notifyTrade };
