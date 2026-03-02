# YouTube Banner Redesign — Safe Zone Architecture

**Date:** 2026-03-02
**Status:** Implemented

## Problem

YouTube banner (2560x1440) had all content crammed into the mobile safe zone (1546x423). Different devices crop differently:

| Device | Visible Area |
|--------|-------------|
| TV | 2560x1440 (full) |
| Desktop | 2560x423 (horizontal strip, y=508-931) |
| Mobile/All | 1546x423 (center of desktop strip) |

## Approach: Unified Expansion

Single cohesive design where content expands outward from mobile safe zone. Each layer adds detail without changing the core message.

## 3-Layer Architecture

### Layer 1 — Mobile Safe Zone (1546x423)
Core brand message visible on ALL devices:
- v3 mascot (composited from reference PNG)
- "aigentry" with evolving letter effect (opacity 0.78→1.0, cool→warm)
- Gold divider line
- "Persistent Memory for Your AI" subtitle

### Layer 2 — Desktop Strip (2560x423)
Extends mobile zone with atmospheric elements:
- 6 concentric rings radiating from center
- Cyan eye glows on left/right sides
- Side braille particle columns

### Layer 3 — TV Full Canvas (2560x1440)
Background atmosphere for TV viewers:
- Radial gradient background with center glow
- Top/bottom braille particle fields
- Dark vignette edges
- Bottom accent line

## Implementation

- **Template:** `brand/social/templates/youtube-banner.html`
- **Output:** `brand/social/youtube-banner.png`
- **Rendering:** Playwright screenshot → PIL composite with v3 mascot
- **Mascot:** Extracted directly from `/Downloads/aigentry-profile-v3.png`

## Design Decisions

1. **Unified expansion over zone-specific content** — simpler, more cohesive
2. **v3 mascot compositing** — PIL extraction preserves exact pixel fidelity
3. **Evolving text effect** — matches profile image style for brand consistency
4. **Removed pills** (brain/deliberation/registry) — replaced with single tagline
