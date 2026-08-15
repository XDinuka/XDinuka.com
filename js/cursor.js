(function () {
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (!fine.matches) return;

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var dot = document.createElement('div');
    dot.className = 'cursor-dot';
    var ring = document.createElement('div');
    ring.className = 'cursor-ring';
    document.body.appendChild(dot);
    document.body.appendChild(ring);
    document.documentElement.classList.add('has-custom-cursor');

    var mouseX = window.innerWidth / 2;
    var mouseY = window.innerHeight / 2;
    var ringX = mouseX;
    var ringY = mouseY;
    var started = false;

    var RING_TAIL = ' translate(-50%,-50%) scale(var(--ring-scale, 1))';

    window.addEventListener('mousemove', function (e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
        dot.style.transform = 'translate(' + mouseX + 'px,' + mouseY + 'px) translate(-50%,-50%)';
        if (!started) {
            ringX = mouseX;
            ringY = mouseY;
            started = true;
        }
        if (reduced) {
            ringX = mouseX;
            ringY = mouseY;
            ring.style.transform = 'translate(' + ringX + 'px,' + ringY + 'px)' + RING_TAIL;
        }
    }, { passive: true });

    var hoverTargets = 'a, button, .btn, input, textarea, [role="button"]';

    document.addEventListener('mouseover', function (e) {
        if (e.target.closest && e.target.closest(hoverTargets)) {
            ring.classList.add('is-hover');
        }
    });
    document.addEventListener('mouseout', function (e) {
        if (e.target.closest && e.target.closest(hoverTargets)) {
            ring.classList.remove('is-hover');
        }
    });

    window.addEventListener('mouseleave', function () {
        dot.style.opacity = '0';
        ring.style.opacity = '0';
    });
    window.addEventListener('mouseenter', function () {
        dot.style.removeProperty('opacity');
        ring.style.removeProperty('opacity');
    });

    if (!reduced) {
        (function tick() {
            ringX += (mouseX - ringX) * 0.18;
            ringY += (mouseY - ringY) * 0.18;
            ring.style.transform = 'translate(' + ringX + 'px,' + ringY + 'px)' + RING_TAIL;
            requestAnimationFrame(tick);
        })();
    }
})();
