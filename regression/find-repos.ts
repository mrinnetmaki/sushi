import path from 'path';
import axios from 'axios';
import fs from 'fs-extra';
import { remove, uniqBy } from 'lodash';
import { axiosGet } from '../src/utils/axiosUtils';

const BUILD_URL_RE = /^([^/]+)\/([^/]+)\/branches\/([^/]+)\/qa\.json$/;
const FSHY_PATHS = ['sushi-config.yaml', 'input/fsh', 'fsh'];
const ORGANIZATIONS = [
  'HL7',
  'hl7au',
  'hl7-be',
  'hl7ch',
  'hl7dk',
  'hl7-eu',
  'hl7-it',
  'HL7NZ',
  'HL7-UK',
  'IHE',
  'IHTSDO',
  'mcode',
  'standardhealth',
  'WorldHealthOrganization'
];

async function main() {
  const allRepos: GHRepo[] = [];
  for (const org of ORGANIZATIONS) {
    const orgRepos = await getOrganizationalReposFromGitHub(org);
    allRepos.push(...orgRepos);
  }
  const buildRepos = await getOtherReposFromBuild();
  allRepos.push(...buildRepos);
  const fshRepos = await getReposWithFSHFolder(allRepos);
  const repoFilePath = path.join(__dirname, 'repos-all.txt');
  const repoFile = fs.readFileSync(repoFilePath, 'utf8');
  const lines = repoFile.split(/\r?\n/).map(line => line.trim());
  const newLines: string[] = [];

  lines.forEach(line => {
    // Remove this line's repo from collected repos if it exists there (whether or not commented out in line)
    const removed = remove(fshRepos, r => {
      const lowerLine = line.toLowerCase();
      const lowerRepoAndBranch = `${r.full_name}#${r.default_branch}`.toLowerCase();
      return (
        lowerLine === lowerRepoAndBranch ||
        (line.startsWith('#') && lowerLine.indexOf(lowerRepoAndBranch) !== -1)
      );
    });
    // If it was found, is commented, or is blank, then it's a valid line, so add it to new lines.
    // Else drop it since it is no longer a valid FSH repo.
    if (removed.length > 0 || line.startsWith('#')) {
      newLines.push(line);
    }
  });

  // Then add the remaining (new) repos
  if (fshRepos.length) {
    newLines.push(`# Added ${new Date()}`);
    newLines.push(...fshRepos.map(r => `${r.full_name}#${r.default_branch}`));
    newLines.push('');

    // Write it out
    fs.writeFileSync(repoFilePath, newLines.join('\n'), 'utf8');
    console.log(`Added ${fshRepos.length} repos to ${repoFilePath}.`);
  } else {
    console.log(`No new repos found; ${repoFilePath} already contains all known FSH repos.`);
  }
}

async function getOrganizationalReposFromGitHub(org: string): Promise<GHRepo[]> {
  console.log(`Getting ${org} repos using GitHub API...`);
  const repos: GHRepo[] = [];
  try {
    for (let page = 1; true; page++) {
      const options: any = {};
      if (process.env.GITHUB_API_KEY) {
        options.headers = { Authorization: `token ${process.env.GITHUB_API_KEY}` };
      }
      const res = await axiosGet(
        `https://api.github.com/orgs/${org}/repos?sort=full_name&per_page=100&page=${page}`,
        options
      );
      if (Array.isArray(res?.data)) {
        repos.push(...res.data.filter(r => r.size > 0 && !r.archived && !r.disabled));
        if (res.data.length < 100) {
          // no more results after this, so break
          break;
        }
      } else {
        break;
      }
    }
    console.log(`Found ${repos.length} active repos at github.com/${org}.`);
  } catch (e) {
    const message = e.response?.status
      ? `HTTP ${e.response.status}: ${e.response.statusText}`
      : `${e}`;
    console.error(`Could not get repos from GitHub: ${message}`);
    if (process.env.GITHUB_API_KEY == null && /rate/i.test(e.response?.statusText)) {
      console.error(
        'To increase rate limits, set the GITHUB_API_KEY environment variable to a GitHub personal access token.'
      );
    }
    process.exit(1);
  }
  return repos;
}

async function getOtherReposFromBuild(): Promise<GHRepo[]> {
  console.log('Getting non-HL7 repos from the auto-builder report...');
  const repoToBranches: Map<string, string[]> = new Map();
  // Build up the map
  const res = await axiosGet('https://build.fhir.org/ig/qas.json');
  if (Array.isArray(res?.data)) {
    res.data.forEach(build => {
      const matches = build.repo?.match(BUILD_URL_RE);
      if (matches) {
        const repo = `${matches[1]}/${matches[2]}`;
        if (!repoToBranches.has(repo)) {
          repoToBranches.set(repo, [matches[3]]);
        } else {
          repoToBranches.get(repo).push(matches[3]);
        }
      }
    });
  }
  // Now convert the map to GHRepo objects
  const repos: GHRepo[] = [];
  for (const repo of repoToBranches.keys()) {
    const branches = repoToBranches.get(repo);
    // Skip organizational ones since we got them from GitHub already
    if (!ORGANIZATIONS.some(org => repo.startsWith(`${org}/`))) {
      // We don't want to use GH API to get default branch (due to API rate limits, so just do our best...)
      const defaultBranch = await guessDefaultBranch(branches, repo);
      if (defaultBranch) {
        repos.push({
          default_branch: defaultBranch,
          full_name: repo,
          html_url: `https://github.com/${repo}`,
          clone_url: `https://github.com/${repo}.git`,
          git_url: `git://github.com/${repo}.git`,
          ssh_url: `git@github.com:${repo}.git`
        });
      }
    }
  }
  console.log(`Found ${repos.length} other repos in the auto-builder report.`);
  return repos;
}

async function guessDefaultBranch(branches: string[], repo: string): Promise<string> {
  // prefer main, then master, then nothing
  for (const branch of ['main', 'master']) {
    if (branches.indexOf(branch) !== -1) {
      // Just because the branch existed once does not mean it still exists, so check for the download tgz
      try {
        const res = await axios.head(`https://github.com/${repo}/archive/refs/heads/${branch}.zip`);
        if (res.status === 200) {
          return branch;
        }
      } catch (e) {
        // The branch does not exist. Continue.
      }
    }
  }
  return;
}

async function getReposWithFSHFolder(repos: GHRepo[]): Promise<GHRepo[]> {
  const fshRepos: GHRepo[] = [];
  for (const repo of uniqBy(repos, r => r.html_url.toLowerCase())) {
    console.log(`Checking ${repo.html_url} for FSHy paths...`);
    for (const fshyPath of FSHY_PATHS) {
      try {
        await axios.head(`${repo.html_url}/tree/${repo.default_branch}/${fshyPath}`);
        fshRepos.push(repo);
        break;
      } catch (e) {
        // 404: fshy path not found
      }
    }
  }
  console.log(`${fshRepos.length} repos had a /fsh folder.`);
  return fshRepos;
}

interface GHRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
}

main();
