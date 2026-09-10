/**
 * "Don't Touch The Cats" — a tiny survival minigame.
 *
 * Cats drift around the page; if one intersects the pointer, the site explodes.
 * Physics run on a fixed timestep with swept collision so behaviour stays fair
 * regardless of frame rate, and all timing is measured against an "active time"
 * clock that excludes paused, hidden, exploding and game-over intervals.
 */
(() => {
	"use strict";

	const CONFIG = {
		step: 1 / 120, // seconds per physics substep
		maxFrame: 0.1, // clamp of accumulated frame time to avoid teleporting
		catRadius: 34,
		pointerRadius: 12,
		baseSpeed: 170, // px/second at t=0
		speedRamp: 11, // extra px/second for every second survived
		maxSpeed: 620,
		graceSeconds: 1.5,
		spawnEvery: 9, // active seconds between new cats
		maxCats: 7,
		safeSpawnFromPointer: 260,
		safeSpawnFromCat: 120,
		spawnIntroSeconds: 0.9, // cats cannot kill you while fading in
		particleCount: 90,
	};

	const STATE = {
		IDLE: "idle",
		GRACE: "grace",
		RUNNING: "running",
		PAUSED: "paused",
		EXPLODING: "exploding",
		GAME_OVER: "gameover",
	};

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

	const dom = {
		shakeRoot: document.getElementById("shakeRoot"),
		catLayer: document.getElementById("catLayer"),
		canvas: document.getElementById("particles"),
		timer: document.getElementById("timer"),
		best: document.getElementById("best"),
		catCount: document.getElementById("catCount"),
		banner: document.getElementById("banner"),
		hint: document.getElementById("hint"),
		overlay: document.getElementById("overlay"),
		finalTime: document.getElementById("finalTime"),
		finalBest: document.getElementById("finalBest"),
		restart: document.getElementById("restart"),
		debris: Array.from(document.querySelectorAll("[data-debris]")),
	};

	const ctx = dom.canvas.getContext("2d");

	/** Reads the stored best time, tolerating unavailable or corrupt storage. */
	function loadBest() {
		try {
			const raw = Number(window.localStorage.getItem("cat-game-best-ms"));
			return Number.isFinite(raw) && raw >= 0 ? raw : 0;
		} catch {
			return 0;
		}
	}

	/** Persists the best time, silently ignoring storage failures. */
	function saveBest(ms) {
		try {
			window.localStorage.setItem("cat-game-best-ms", String(Math.round(ms)));
		} catch {
			/* storage unavailable (private mode, blocked cookies) — play on */
		}
	}

	const game = {
		state: STATE.IDLE,
		activeTime: 0, // seconds of gameplay, excluding pauses
		bestMs: loadBest(),
		cats: [],
		particles: [],
		nextSpawnAt: CONFIG.spawnEvery,
		lastFrame: 0,
		accumulator: 0,
		rafId: 0,
		timeouts: new Set(),
	};

	const pointer = {
		x: -9999,
		y: -9999,
		active: false, // inside the window and known
		armed: false, // actually dangerous right now
		isTouch: false,
	};

	/** Registers a timeout so every pending callback can be cancelled on reset. */
	function later(fn, ms) {
		const id = window.setTimeout(() => {
			game.timeouts.delete(id);
			fn();
		}, ms);
		game.timeouts.add(id);
		return id;
	}

	function clearTimeouts() {
		for (const id of game.timeouts) window.clearTimeout(id);
		game.timeouts.clear();
	}

	function formatSeconds(ms) {
		return (ms / 1000).toFixed(2);
	}

	function showBanner(text) {
		dom.banner.textContent = text;
		dom.banner.classList.toggle("visible", Boolean(text));
	}

	const CAT_SVG = `
<svg class="cat-inner" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <g class="cat-body">
    <path d="M50 92c-16 0-30-9-30-26 0-8 3-15 3-15l-6-24c-.5-2 1.6-3.6 3.4-2.5L38 32a44 44 0 0 1 24 0l17.6-7.5c1.8-1.1 3.9.5 3.4 2.5l-6 24s3 7 3 15c0 17-14 26-30 26Z" fill="#ffd6ec" stroke="#3b2154" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="38" cy="52" r="6" fill="#3b2154"/>
    <circle cx="62" cy="52" r="6" fill="#3b2154"/>
    <circle cx="40" cy="50" r="2" fill="#fff"/>
    <circle cx="64" cy="50" r="2" fill="#fff"/>
    <path d="M50 62c-3 0-5 2-5 4s2 4 5 4 5-2 5-4-2-4-5-4Z" fill="#ff7bb5"/>
    <path d="M22 60h16M22 68h16M62 60h16M62 68h16" stroke="#3b2154" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;

	/** Creates a cat at a position that is fair for the player, then tracks it. */
	function spawnCat() {
		if (game.cats.length >= CONFIG.maxCats) return;

		const spot = findSafeSpawn();
		const angle = Math.random() * Math.PI * 2;
		const el = document.createElement("div");
		el.className = "cat spawning";
		el.innerHTML = CAT_SVG;
		dom.catLayer.appendChild(el);

		const cat = {
			x: spot.x,
			y: spot.y,
			dirX: Math.cos(angle),
			dirY: Math.sin(angle),
			wobble: Math.random() * Math.PI * 2,
			bornAt: game.activeTime,
			el,
			inner: el.querySelector(".cat-inner"),
		};
		game.cats.push(cat);
		later(() => el.classList.remove("spawning"), CONFIG.spawnIntroSeconds * 1000);
		renderCat(cat);
		dom.catCount.textContent = String(game.cats.length);
	}

	/** Picks a spawn point away from the pointer and from other cats. */
	function findSafeSpawn() {
		const pad = CONFIG.catRadius + 10;
		let best = null;
		let bestScore = -Infinity;

		for (let i = 0; i < 40; i += 1) {
			const x = pad + Math.random() * (window.innerWidth - pad * 2);
			const y = pad + Math.random() * (window.innerHeight - pad * 2);
			let score = pointer.active ? Math.hypot(x - pointer.x, y - pointer.y) : Infinity;
			for (const cat of game.cats) {
				score = Math.min(score, Math.hypot(x - cat.x, y - cat.y) * 2);
			}
			if (
				score > bestScore ||
				(!pointer.active && score >= CONFIG.safeSpawnFromCat)
			) {
				bestScore = score;
				best = { x, y };
			}
			if (
				score >= CONFIG.safeSpawnFromPointer &&
				score >= CONFIG.safeSpawnFromCat
			) {
				return { x, y };
			}
		}
		return best || { x: window.innerWidth / 2, y: 80 };
	}

	function currentSpeed() {
		return Math.min(
			CONFIG.maxSpeed,
			CONFIG.baseSpeed + game.activeTime * CONFIG.speedRamp
		);
	}

	/**
	 * Advances one fixed substep: moves cats, reflects them off the viewport
	 * edges with overshoot correction, and reports a swept pointer collision.
	 */
	function stepPhysics(dt) {
		const speed = currentSpeed() * (reduceMotion.matches ? 0.75 : 1);
		const minX = CONFIG.catRadius;
		const minY = CONFIG.catRadius;
		const maxX = Math.max(minX, window.innerWidth - CONFIG.catRadius);
		const maxY = Math.max(minY, window.innerHeight - CONFIG.catRadius);
		let hit = false;

		for (const cat of game.cats) {
			const prevX = cat.x;
			const prevY = cat.y;
			let nextX = cat.x + cat.dirX * speed * dt;
			let nextY = cat.y + cat.dirY * speed * dt;

			// Reflect repeatedly so a big step cannot escape the viewport.
			for (let i = 0; i < 4; i += 1) {
				if (nextX < minX) {
					nextX = minX + (minX - nextX);
					cat.dirX = Math.abs(cat.dirX);
				} else if (nextX > maxX) {
					nextX = maxX - (nextX - maxX);
					cat.dirX = -Math.abs(cat.dirX);
				} else if (nextY < minY) {
					nextY = minY + (minY - nextY);
					cat.dirY = Math.abs(cat.dirY);
				} else if (nextY > maxY) {
					nextY = maxY - (nextY - maxY);
					cat.dirY = -Math.abs(cat.dirY);
				} else {
					break;
				}
			}

			cat.x = clamp(nextX, minX, maxX);
			cat.y = clamp(nextY, minY, maxY);
			cat.wobble += dt * 6;

			const grown = game.activeTime - cat.bornAt >= CONFIG.spawnIntroSeconds;
			if (
				!hit &&
				grown &&
				pointer.armed &&
				game.state === STATE.RUNNING &&
				segmentDistance(prevX, prevY, cat.x, cat.y, pointer.x, pointer.y) <=
					CONFIG.catRadius + CONFIG.pointerRadius
			) {
				hit = true;
			}
		}
		return hit;
	}

	function clamp(value, min, max) {
		return value < min ? min : value > max ? max : value;
	}

	/**
	 * True when a cat is close enough to the pointer that ending the grace
	 * period would be an unavoidable loss; also steers those cats away.
	 */
	function pointerIsCrowded() {
		if (!pointer.armed) return false;
		const danger = (CONFIG.catRadius + CONFIG.pointerRadius) * 2.5;
		let crowded = false;
		for (const cat of game.cats) {
			const dx = cat.x - pointer.x;
			const dy = cat.y - pointer.y;
			const dist = Math.hypot(dx, dy) || 1;
			if (dist <= danger) {
				crowded = true;
				cat.dirX = dx / dist;
				cat.dirY = dy / dist;
			}
		}
		return crowded;
	}

	/** Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by). */
	function segmentDistance(ax, ay, bx, by, px, py) {
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSq = dx * dx + dy * dy;
		if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
		let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
		t = clamp(t, 0, 1);
		return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
	}

	/** Writes a cat's logical position to the DOM; decoration stays on the inner node. */
	function renderCat(cat) {
		const size = CONFIG.catRadius * 2;
		cat.el.style.width = `${size}px`;
		cat.el.style.height = `${size}px`;
		cat.el.style.transform = `translate(${cat.x - CONFIG.catRadius}px, ${
			cat.y - CONFIG.catRadius
		}px)`;
		if (!reduceMotion.matches) {
			const tilt = Math.sin(cat.wobble) * 8 + cat.dirX * 6;
			cat.inner.style.transform = `rotate(${tilt}deg)`;
		}
	}

	function updateHud() {
		dom.timer.textContent = formatSeconds(game.activeTime * 1000);
		dom.best.textContent = formatSeconds(game.bestMs);
		dom.catCount.textContent = String(game.cats.length);
	}

	function loop(timestamp) {
		game.rafId = window.requestAnimationFrame(loop);

		if (!game.lastFrame) game.lastFrame = timestamp;
		const delta = Math.min((timestamp - game.lastFrame) / 1000, CONFIG.maxFrame);
		game.lastFrame = timestamp;

		if (game.state === STATE.GRACE || game.state === STATE.RUNNING) {
			game.accumulator += delta;
			while (game.accumulator >= CONFIG.step) {
				game.accumulator -= CONFIG.step;
				game.activeTime += CONFIG.step;

				if (
					game.state === STATE.GRACE &&
					game.activeTime >= graceTarget
				) {
					if (pointerIsCrowded()) {
						// Don't drop the shield while a cat is already on top of
						// the cursor; shoo it away and hold grace a moment longer.
						graceTarget = game.activeTime + 0.4;
					} else {
						game.state = STATE.RUNNING;
						showBanner("");
					}
				}

				const hit = stepPhysics(CONFIG.step);
				if (hit) {
					explode();
					break;
				}

				if (
					game.state === STATE.RUNNING &&
					game.activeTime >= game.nextSpawnAt
				) {
					game.nextSpawnAt += CONFIG.spawnEvery;
					spawnCat();
					showBanner("A new cat has entered the chat 🐈");
					later(() => showBanner(""), 1600);
				}
			}
			for (const cat of game.cats) renderCat(cat);
			updateHud();
		}

		drawParticles(delta);
	}

	/* ---------------------------------------------------------------- *
	 * Explosion + particles
	 * ---------------------------------------------------------------- */

	/** Ends the run: throws the page content, bursts particles, shows the overlay. */
	function explode() {
		if (game.state === STATE.EXPLODING || game.state === STATE.GAME_OVER) return;
		game.state = STATE.EXPLODING;
		showBanner("");

		const finalMs = game.activeTime * 1000;
		if (finalMs > game.bestMs) {
			game.bestMs = finalMs;
			saveBest(finalMs);
		}

		if (!reduceMotion.matches) {
			dom.shakeRoot.classList.add("shaking");
			for (const piece of dom.debris) {
				piece.style.setProperty("--dx", `${(Math.random() - 0.5) * 900}px`);
				piece.style.setProperty("--dy", `${(Math.random() - 0.4) * 900}px`);
				piece.style.setProperty("--dr", `${(Math.random() - 0.5) * 120}deg`);
				piece.style.setProperty("--ds", `${0.4 + Math.random() * 0.4}`);
			}
		}
		for (const piece of dom.debris) piece.classList.add("debris");

		burstParticles(pointer.x, pointer.y);
		for (const cat of game.cats) cat.el.style.opacity = "0";

		later(() => {
			game.state = STATE.GAME_OVER;
			dom.finalTime.textContent = formatSeconds(finalMs);
			dom.finalBest.textContent = formatSeconds(game.bestMs);
			dom.overlay.hidden = false;
			dom.restart.focus();
			updateHud();
		}, 850);
	}

	/** Emits a short-lived canvas particle burst at the collision point. */
	function burstParticles(x, y) {
		const count = reduceMotion.matches
			? Math.round(CONFIG.particleCount / 4)
			: CONFIG.particleCount;
		const colors = ["#ffb3d9", "#7ee7ff", "#fff3a3", "#ff7bb5", "#ffffff"];
		for (let i = 0; i < count; i += 1) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 120 + Math.random() * 520;
			game.particles.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				life: 0.8 + Math.random() * 0.8,
				age: 0,
				size: 2 + Math.random() * 5,
				color: colors[i % colors.length],
			});
		}
	}

	/** Integrates and paints particles; a no-op once the list drains. */
	function drawParticles(delta) {
		if (!game.particles.length) {
			ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
			return;
		}
		ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
		const alive = [];
		for (const p of game.particles) {
			p.age += delta;
			if (p.age >= p.life) continue;
			p.vy += 900 * delta;
			p.x += p.vx * delta;
			p.y += p.vy * delta;
			ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
			ctx.fillStyle = p.color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
			ctx.fill();
			alive.push(p);
		}
		ctx.globalAlpha = 1;
		game.particles = alive;
	}

	/* ---------------------------------------------------------------- *
	 * Lifecycle
	 * ---------------------------------------------------------------- */

	/** Tears down a finished round and arms a fresh one. */
	function resetGame() {
		clearTimeouts();
		for (const cat of game.cats) cat.el.remove();
		game.cats = [];
		game.particles = [];
		ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);

		dom.shakeRoot.classList.remove("shaking");
		for (const piece of dom.debris) {
			piece.classList.remove("debris");
			piece.style.removeProperty("--dx");
			piece.style.removeProperty("--dy");
			piece.style.removeProperty("--dr");
			piece.style.removeProperty("--ds");
		}
		dom.overlay.hidden = true;

		game.activeTime = 0;
		game.accumulator = 0;
		game.nextSpawnAt = CONFIG.spawnEvery;
		game.lastFrame = 0;
		updateHud();

		spawnCat();
		startRound();
	}

	/** Enters the grace period if the pointer is ready, otherwise waits for it. */
	function startRound() {
		graceTarget = game.activeTime + CONFIG.graceSeconds;
		if (pointer.active) {
			game.state = STATE.GRACE;
			showBanner("Get ready…");
			dom.hint.textContent = "Keep your cursor away from the cats!";
		} else {
			game.state = STATE.IDLE;
			showBanner(
				pointer.isTouch ? "Touch and drag to play." : "Move your mouse to start."
			);
		}
	}

	/** Resumes play after the pointer returns, with a fresh grace window. */
	function resumeFromPause() {
		if (game.state !== STATE.PAUSED && game.state !== STATE.IDLE) return;
		game.state = STATE.GRACE;
		game.accumulator = 0;
		game.lastFrame = 0;
		graceTarget = game.activeTime + CONFIG.graceSeconds;
		// Never let a spawn land during the resume grace window.
		game.nextSpawnAt = Math.max(game.nextSpawnAt, graceTarget);
		dom.hint.textContent = "Keep your cursor away from the cats!";
		showBanner("Get ready…");
	}

	let graceTarget = CONFIG.graceSeconds;

	function pauseGame(reason) {
		if (game.state !== STATE.RUNNING && game.state !== STATE.GRACE) return;
		game.state = STATE.PAUSED;
		showBanner(reason);
	}

	function resizeCanvas() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		dom.canvas.width = Math.round(window.innerWidth * dpr);
		dom.canvas.height = Math.round(window.innerHeight * dpr);
		dom.canvas.style.width = `${window.innerWidth}px`;
		dom.canvas.style.height = `${window.innerHeight}px`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		for (const cat of game.cats) {
			cat.x = clamp(cat.x, CONFIG.catRadius, window.innerWidth - CONFIG.catRadius);
			cat.y = clamp(cat.y, CONFIG.catRadius, window.innerHeight - CONFIG.catRadius);
			renderCat(cat);
		}
	}

	/* ---------------------------------------------------------------- *
	 * Input
	 * ---------------------------------------------------------------- */

	window.addEventListener(
		"pointermove",
		(event) => {
			pointer.x = event.clientX;
			pointer.y = event.clientY;
			pointer.isTouch = event.pointerType !== "mouse";
			pointer.active = true;
			// A finger is only dangerous while it is pressed against the screen.
			pointer.armed = pointer.isTouch ? event.pressure > 0 || event.buttons > 0 : true;
			if (game.state === STATE.IDLE || game.state === STATE.PAUSED) {
				resumeFromPause();
			}
		},
		{ passive: true }
	);

	window.addEventListener("pointerdown", (event) => {
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		pointer.isTouch = event.pointerType !== "mouse";
		pointer.active = true;
		pointer.armed = true;
		if (game.state === STATE.IDLE || game.state === STATE.PAUSED) resumeFromPause();
	});

	for (const type of ["pointerup", "pointercancel"]) {
		window.addEventListener(type, () => {
			if (pointer.isTouch) {
				pointer.armed = false;
				pauseGame("Touch and drag to keep playing.");
			}
		});
	}

	document.addEventListener("pointerleave", () => {
		pointer.active = false;
		pointer.armed = false;
		pauseGame("Paused — bring your cursor back.");
	});

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			pauseGame("Paused.");
		} else {
			game.lastFrame = 0;
		}
	});

	window.addEventListener("resize", resizeCanvas);
	window.addEventListener("blur", () => pauseGame("Paused."));

	dom.restart.addEventListener("click", () => {
		pointer.armed = !pointer.isTouch && pointer.active;
		resetGame();
	});

	/* ---------------------------------------------------------------- *
	 * Boot
	 * ---------------------------------------------------------------- */

	resizeCanvas();
	updateHud();
	spawnCat();
	startRound();
	game.rafId = window.requestAnimationFrame(loop);
})();
