import { test, expect } from './fixtures'

test('shows the welcome screen when no repo is set', async ({ window }) => {
  await expect(window.getByRole('heading', { name: 'SimpleEdit' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Open Repository...' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Checkout Repository...' })).toBeVisible()
})

test('clone form is hidden by default', async ({ window }) => {
  await expect(window.getByLabel('Repository URL')).not.toBeVisible()
})

test('clone form expands when Checkout Repository is clicked', async ({ window }) => {
  await window.getByRole('button', { name: 'Checkout Repository...' }).click()
  await expect(window.getByLabel('Repository URL')).toBeVisible()
  await expect(window.getByLabel('Destination')).toBeVisible()
})

test('Clone button is disabled when fields are empty', async ({ window }) => {
  await window.getByRole('button', { name: 'Checkout Repository...' }).click()
  await expect(window.getByRole('button', { name: 'Clone' })).toBeDisabled()
})
