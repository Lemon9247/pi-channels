import { type NameTheme } from "./types.js";

// ─── Word Lists ─────────────────────────────────────────────────────

const CREATURE_ADJ = [
    "Cozy", "Neon", "Frosty", "Warm", "Swift", "Bold", "Calm",
    "Dizzy", "Fuzzy", "Jolly", "Lucky", "Plucky", "Rusty", "Salty",
    "Sunny", "Tiny", "Witty", "Zippy", "Bright", "Crisp",
];

const CREATURE_NOUN = [
    "Badger", "Penguin", "Owl", "Hedgehog", "Fox", "Otter", "Raven",
    "Falcon", "Panda", "Wolf", "Hare", "Lynx", "Crane", "Gecko",
    "Koala", "Moose", "Quail", "Stoat", "Wren", "Yak",
];

const NATURE_WORDS = [
    "Oak", "Creek", "Fern", "Glade", "Moss", "Stone", "Birch",
    "Ridge", "Dew", "Mist", "Thorn", "Brook", "Glen", "Ash",
    "Cliff", "Sage", "Pine", "Vale", "Reed", "Frost",
];

const SPACE_WORDS = [
    "Nova", "Drift", "Pulsar", "Beam", "Cosmic", "Forge", "Nebula",
    "Orbit", "Quasar", "Star", "Void", "Comet", "Flare", "Lunar",
    "Solar", "Astro", "Zenith", "Photon", "Plasma", "Warp",
];

const GREEK = [
    "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta",
    "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi",
    "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon",
];

const CLASSIC_ADJ = [
    "Swift", "Bright", "Calm", "Dark", "Eager", "Fair", "Grand",
    "Keen", "Noble", "Quick", "Sharp", "True", "Vast", "Wild",
    "Azure", "Crimson", "Golden", "Silver", "Iron", "Jade",
];

const CLASSIC_NOUN = [
    "Falcon", "Storm", "Raven", "Shield", "Arrow", "Blade", "Crown",
    "Flame", "Forge", "Gate", "Haven", "Lance", "Peak", "Sage",
    "Tide", "Tower", "Wind", "Phoenix", "Sentinel", "Spark",
];

// ─── Generator ──────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Generate a name for the given theme.
 */
export function generateName(
    theme: NameTheme,
    customWords?: { adj: string[]; noun: string[] } | null,
): string {
    switch (theme) {
        case "creatures":
            return pick(CREATURE_ADJ) + pick(CREATURE_NOUN);
        case "nature":
            return pick(NATURE_WORDS) + pick(NATURE_WORDS);
        case "space":
            return pick(SPACE_WORDS) + pick(SPACE_WORDS);
        case "minimal":
            return pick(GREEK);
        case "classic":
            return pick(CLASSIC_ADJ) + pick(CLASSIC_NOUN);
        case "custom":
            if (customWords?.adj?.length && customWords?.noun?.length) {
                return pick(customWords.adj) + pick(customWords.noun);
            }
            // Fallback to creatures
            return pick(CREATURE_ADJ) + pick(CREATURE_NOUN);
        default:
            return pick(CREATURE_ADJ) + pick(CREATURE_NOUN);
    }
}

/**
 * Generate a unique name that doesn't collide with existing names.
 * Appends numeric suffix on collision.
 */
export function generateUniqueName(
    theme: NameTheme,
    existingNames: Set<string>,
    customWords?: { adj: string[]; noun: string[] } | null,
): string {
    // Try up to 20 times to find a non-colliding name
    for (let i = 0; i < 20; i++) {
        const name = generateName(theme, customWords);
        if (!existingNames.has(name)) return name;
    }

    // Fallback: append suffix
    const base = generateName(theme, customWords);
    let suffix = 2;
    while (existingNames.has(`${base}${suffix}`)) {
        suffix++;
    }
    return `${base}${suffix}`;
}
