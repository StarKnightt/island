/loop 

Build a realistic open-world island game that runs in the browser. Quality is the only thing that matters. People should watch the video and think it's a real game.

THE WORLD
You spawn on a beach at sunrise. Everything visible is reachable on foot: dense jungle, a waterfall with a pool you can swim in, a small fishing village with docks and boats, rocky cliffs, and a lighthouse on the highest peak. From the lighthouse you can see the whole island and the ocean around it. Time of day moves on its own, and rain sometimes rolls in and clears up. Third-person character with smooth movement: walk, sprint, jump, swim, climb gentle slopes. Ambient sound everywhere: waves, wind, birds, rain, footsteps that change with the ground.

FREEDOM
You have full freedom. Use any library, engine feature, technique, or third-party asset you want: 3D models, characters, animations, HDRIs, textures, sounds. Only check that each asset's license allows public use, and credit it in CREDITS.md. If something looks fake, replace it with something better. Don't settle.

FIRST
Run /find-skills s and use what's useful. Also pull in:
- github.com/cloudai-x/threejs-skills
- github.com/dgreenheck/webgpu-claude-skill
- https://github.com/majidmanzarpour/threejs-game-skills 
- https://skills.sh 

THE GAUNTLET (sequential, one agent at a time, never parallel)
1. BUILDER: builds or improves the game.
2. CRITIC: a separate agent that never wrote the code. Opens the game on the second screen, takes screenshots from the beach, jungle, waterfall, village, cliffs and lighthouse at sunrise, noon, sunset, night and rain. Puts each screenshot next to real photographs of tropical islands and screenshots of top AAA open-world games, then lists every specific difference: lighting, water, foliage density, materials, scale, fog, shadows, animation. No "looks good" judgments, only concrete gaps against the references.
3. BUILDER fixes the biggest gaps first.
4. Repeat until the critic can't find a meaningful difference that matters to a viewer, or until 8 rounds.

RULES
- Use pnpm for everything.
- My PC: Ryzen 5 7600X, RTX 4060, 32GB RAM. Don't max out CPU or GPU while building or testing. Target a smooth 60fps in Chrome on this machine.
- Run tests on the second screen.
- Keep loading fast. Show a clean loading screen while assets stream in.

WHEN DONE
- Make an OG image from the best in-game shot and set it as the GitHub repo social preview.
- Give me a short list of the 5 best camera spots for recording the video.