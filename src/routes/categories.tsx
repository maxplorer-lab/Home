/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { generateId } from '../lib/utils'
import type { Env, User, CategoryGroup, Category } from '../db/schema'

const categories = new Hono<{ Bindings: Env; Variables: { user: User } }>()
categories.use('*', requireAuth)

categories.get('/', async (c) => {
  const user = c.get('user')

  const groups = await c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>()
  const cats = await c.env.DB.prepare('SELECT * FROM categories ORDER BY sort_order').all<Category>()

  return c.html(
    <Layout title="Categories" user={user} activeTab="settings">
      <div class="mb-6 flex justify-between items-center">
        <h2 class="text-xl font-bold">Manage Categories</h2>
        <a href="/categories/add-group" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
          + New Group
        </a>
      </div>

      <div class="space-y-6">
        {groups.results.map(group => {
          const groupCats = cats.results.filter(cat => cat.group_id === group.id)
          return (
            <Card title={group.name}>
              <div class="mb-4 text-sm text-gray-500">
                <a href={`/categories/edit-group/${group.id}`} class="text-blue-600 hover:underline">Edit Group</a>
              </div>
              {groupCats.length === 0 ? (
                <p class="text-sm text-gray-400">No subcategories.</p>
              ) : (
                <ul class="space-y-2 mb-4">
                  {groupCats.map(cat => (
                    <li class="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 pb-2">
                      <span class="text-sm font-medium">{cat.name}</span>
                      <a href={`/categories/edit-cat/${cat.id}`} class="text-xs text-blue-600 hover:underline">Edit</a>
                    </li>
                  ))}
                </ul>
              )}
              <a href={`/categories/add-cat?group_id=${group.id}`} class="text-sm text-green-600 font-medium">+ Add Subcategory</a>
            </Card>
          )
        })}
      </div>
    </Layout>
  )
})

// ADD GROUP
categories.get('/add-group', (c) => {
  return c.html(
    <Layout title="New Group" user={c.get('user')} activeTab="settings">
      <Card title="New Category Group">
        <form method="post" action="/categories/add-group" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Group Name</label>
            <input type="text" name="name" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Sort Order</label>
            <input type="number" name="sort_order" value="10" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <button type="submit" class="w-full bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-700">Save Group</button>
        </form>
      </Card>
    </Layout>
  )
})

categories.post('/add-group', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name)
  const sort = Number(body.sort_order) || 10
  const id = 'cg_' + generateId().slice(0, 8)

  await c.env.DB.prepare('INSERT INTO category_groups (id, name, sort_order) VALUES (?, ?, ?)')
    .bind(id, name, sort).run()
  return c.redirect('/categories')
})

// EDIT GROUP
categories.get('/edit-group/:id', async (c) => {
  const id = c.req.param('id')
  const group = await c.env.DB.prepare('SELECT * FROM category_groups WHERE id = ?').bind(id).first<CategoryGroup>()
  if (!group) return c.redirect('/categories')

  return c.html(
    <Layout title="Edit Group" user={c.get('user')} activeTab="settings">
      <Card title="Edit Category Group">
        <form method="post" action={`/categories/edit-group/${id}`} class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Group Name</label>
            <input type="text" name="name" value={group.name} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Sort Order</label>
            <input type="number" name="sort_order" value={String(group.sort_order)} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <button type="submit" class="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700">Update Group</button>
        </form>
      </Card>
    </Layout>
  )
})

categories.post('/edit-group/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const name = String(body.name)
  const sort = Number(body.sort_order) || 10

  await c.env.DB.prepare('UPDATE category_groups SET name = ?, sort_order = ? WHERE id = ?')
    .bind(name, sort, id).run()
  return c.redirect('/categories')
})

// ADD CAT
categories.get('/add-cat', (c) => {
  const groupId = c.req.query('group_id')
  return c.html(
    <Layout title="New Subcategory" user={c.get('user')} activeTab="settings">
      <Card title="New Subcategory">
        <form method="post" action="/categories/add-cat" class="space-y-4">
          <input type="hidden" name="group_id" value={groupId} />
          <div>
            <label class="block text-sm font-medium mb-1">Subcategory Name</label>
            <input type="text" name="name" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Target Budget (MGA)</label>
            <input type="number" name="target_budget" value="0" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Sort Order</label>
            <input type="number" name="sort_order" value="10" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <button type="submit" class="w-full bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-700">Save Subcategory</button>
        </form>
      </Card>
    </Layout>
  )
})

categories.post('/add-cat', async (c) => {
  const body = await c.req.parseBody()
  const groupId = String(body.group_id)
  const name = String(body.name)
  const budget = Number(body.target_budget) || 0
  const sort = Number(body.sort_order) || 10
  const id = 'cat_' + generateId().slice(0, 8)

  await c.env.DB.prepare('INSERT INTO categories (id, group_id, name, target_budget, sort_order) VALUES (?, ?, ?, ?, ?)')
    .bind(id, groupId, name, budget, sort).run()
  return c.redirect('/categories')
})

// EDIT CAT
categories.get('/edit-cat/:id', async (c) => {
  const id = c.req.param('id')
  const cat = await c.env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first<Category>()
  if (!cat) return c.redirect('/categories')
  
  const groups = await c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>()

  return c.html(
    <Layout title="Edit Subcategory" user={c.get('user')} activeTab="settings">
      <Card title="Edit Subcategory">
        <form method="post" action={`/categories/edit-cat/${id}`} class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Parent Group</label>
            <select name="group_id" class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3">
              {groups.results.map(g => (
                <option value={g.id} selected={g.id === cat.group_id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Subcategory Name</label>
            <input type="text" name="name" value={cat.name} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Target Budget (MGA)</label>
            <input type="number" name="target_budget" value={String(cat.target_budget)} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Sort Order</label>
            <input type="number" name="sort_order" value={String(cat.sort_order)} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <button type="submit" class="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700">Update Subcategory</button>
        </form>
      </Card>
    </Layout>
  )
})

categories.post('/edit-cat/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const groupId = String(body.group_id)
  const name = String(body.name)
  const budget = Number(body.target_budget) || 0
  const sort = Number(body.sort_order) || 10

  await c.env.DB.prepare('UPDATE categories SET group_id = ?, name = ?, target_budget = ?, sort_order = ? WHERE id = ?')
    .bind(groupId, name, budget, sort, id).run()
  return c.redirect('/categories')
})

export default categories
