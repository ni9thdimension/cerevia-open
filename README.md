# Cerevia Open

Two small, tested building blocks from the team behind [Cerevia](https://cerevia.in), published under the MIT or Apache-2.0 license, at your choice.
They are useful on their own and are separate from Cerevia's product.

| Package | What it is | Language | Needs |
|---|---|---|---|
| [`motion/`](motion) | **Cerevia Motion.** Physics-based UI motion: springs in the response and damping-ratio form, gravity, path drawing, a curl-noise particle system, reduced-motion support, and a Newton's cradle that is a real simulation | JavaScript, browser and Node | nothing |
| [`switchboard/`](switchboard) | **Switchboard.** A ledger of every model call (which model, how long, how many tokens) and an automatic switcher between model providers, with cool-downs, Auto / Fastest / Fixed modes and per-visitor token counts | Python 3.9+ | standard library only |

## Motion

```html
<script src="motion/motion.js"></script>
<script>
  const spring = CereviaMotion.createSpring({ response: 0.4, ratio: 1,        // ratio 1: no overshoot
                                              onUpdate: x => box.style.transform = `translateX(${x}px)` });
  spring.to(300);                                                             // retargeting keeps velocity
</script>
```

Open [`motion/demo.html`](motion/demo.html) through any static server to see springs and the cradle.

The physics is checked, not asserted:

```bash
cd motion
node test_motion.js     # critical damping, settling time against theory, reduced-motion behaviour
node test_cradle.js     # pendulum period, energy and momentum through collisions
```

Every function jumps to its end state when the operating system asks for reduced motion (or `html[data-motion="reduce"]` is set).

## Switchboard

```python
import time, switchboard as sb

for client, label in sb.order(chain):                   # your providers, broken ones moved to the back
    t0 = time.time()
    try:
        answer = call(client)
        sb.record(label, "drafts", True, (time.time() - t0) * 1000, model="m", tin=1200, tout=3400)
        break
    except Exception as exc:                            # a timeout, 429, 5xx or 404 cools that provider for a while
        sb.record(label, "drafts", False, (time.time() - t0) * 1000, error=str(exc))
```

```bash
cd switchboard
python test_switchboard.py
```

It keeps no prompts, no answers and no keys. Counts live in the running process, so on a serverless host each instance has its own.

## What is not here

Cerevia's product and its engine are proprietary and are not part of this repository.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache License 2.0](LICENSE-APACHE), at your option. See [NOTICE](NOTICE). The licenses cover this code. They do not grant any right to the name, logo or domain **Cerevia / cerevia.in**.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately to founder@cerevia.in, as described in [SECURITY.md](SECURITY.md).
