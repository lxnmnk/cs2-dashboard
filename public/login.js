document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const errorEl = document.getElementById("loginError");

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();

  if (!data.ok) {
    errorEl.textContent = data.error || "Sign in failed";
    errorEl.style.display = "block";
    return;
  }

  // Инвестору вся панель закрыта сервером, и "/arbitrage" всё равно отбросил
  // бы его на капитал — ведём сразу туда, без лишнего прыжка.
  window.location.href = data.role === "investor" ? "/capital" : "/arbitrage";
});
