import { listCalendar } from './calendar.js';
import { ensureAdminProfile, listPosts } from './board.js';
import { listCategories, withCategoryPostCounts } from './categories.js';
import { listShortcuts } from './shortcuts.js';

export function loadBoardContent(env) {
  return Promise.all([
    listPosts(env),
    listCategories(env),
    listShortcuts(env),
    listCalendar(env)
  ]);
}

export async function createBoardBootstrap(env, user, { board = loadBoardContent(env), profile: profileLookup } = {}) {
  const [profile, [posts, categories, shortcuts, events]] = await Promise.all([
    ensureAdminProfile(env, user, profileLookup),
    board
  ]);

  return {
    user: { id: user.id, email: user.email, role: 'admin' },
    profile,
    posts,
    categories: withCategoryPostCounts(categories, posts),
    shortcuts,
    events
  };
}
