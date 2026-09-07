import { ensureAdminProfile, listPosts } from './board.js';
import { listCategories, withCategoryPostCounts } from './categories.js';
import { listShortcuts } from './shortcuts.js';

export async function createBoardBootstrap(env, user) {
  // All reads are independent once the caller has authenticated the user.
  // Running them together removes multiple Supabase round trips from the
  // critical path of every app launch.
  const [profile, posts, categories, shortcuts] = await Promise.all([
    ensureAdminProfile(env, user),
    listPosts(env),
    listCategories(env),
    listShortcuts(env)
  ]);

  return {
    user: { id: user.id, email: user.email, role: 'admin' },
    profile,
    posts,
    categories: withCategoryPostCounts(categories, posts),
    shortcuts
  };
}
