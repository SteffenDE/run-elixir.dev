// What a project's page and the projects' list ask of the projects' list
// (projects.ts), wherever it is: on this origin, or on a project's own
// origin through the apex's registry frame (site.ts, frames.ts). A
// project's origin can only ask about itself.
import { call } from './frames';
import * as local from './projects';
import type { Project } from './projects';
import type { Shared } from './share';
import { apexUrl, projectOrigin, projectUrl, onDomain } from './site';
import { deleteProject, deleteStores } from './storage';
import type { Template } from './templates';

const registry = (method: string, ...args: unknown[]) =>
  call<unknown>(apexUrl('/registry.html'), method, ...args);

export function getProject(id: string): Promise<Project | undefined> {
  return projectOrigin() ? (registry('get') as Promise<Project | undefined>) : local.getProject(id);
}

export async function openedProject(id: string): Promise<void> {
  if (projectOrigin()) await registry('opened');
  else await local.openedProject(id);
}

export async function renameProject(id: string, name: string): Promise<void> {
  if (projectOrigin()) await registry('rename', name);
  else await local.renameProject(id, name);
}

export async function templateSeen(id: string, template: Template): Promise<void> {
  if (projectOrigin()) await registry('templateSeen', template);
  else await local.templateSeen(id, template);
}

export function takeSeed(id: string): Promise<Shared | null> {
  return projectOrigin() ? (registry('takeSeed') as Promise<Shared | null>) : local.takeSeed(id);
}

export async function seedTaken(id: string): Promise<void> {
  if (projectOrigin()) await registry('seedTaken');
  else await local.seedTaken(id);
}

// On a project's own origin: tell the apex the project is open here, for
// as long as this page lives (its list shows it, and keeps it).
export async function heldOpen(): Promise<void> {
  if (projectOrigin()) await registry('hold');
}

// From the projects' list: delete a project and everything it keeps,
// through its own origin's storage frame if it has one.
export async function deleteEverywhere(id: string): Promise<void> {
  if (!onDomain()) return deleteProject(id);
  await call(`${projectUrl(id)}storage.html`, 'delete');
  await local.removeProject(id);
}

// For the storage frame, on a project's origin.
export const deleteOwnStores = (id: string) => deleteStores(id, true);
