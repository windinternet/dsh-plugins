import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenApps, scanProjects } from '../src/project-scanner.js';

/**
 * 这一组测试只验证扫描/归一化规则，不启动任何进程。
 * 夹具都是临时目录，不依赖本机真实项目结构。
 */

/**
 * 写文件，自动建父目录。
 * @param {string} file
 * @param {string} content
 */
async function write(file, content) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
}

/**
 * 建一个空的 .git 目录，模拟一个 git 仓库。
 * @param {string} dir
 */
async function git(dir) {
  await mkdir(join(dir, '.git'), { recursive: true });
}

/**
 * 取项目下的全部应用。
 * @param {import('../src/project-scanner.js').Project[]} projects
 */
function appsOf(projects) {
  return flattenApps(projects);
}

test('项目判定：扫描根是 git 时只算一个项目，嵌套 .git 不算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-git-'));
  try {
    await git(dir);
    await write(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', scripts: { dev: 'node .' } }),
    );
    await git(join(dir, 'vendor-repo'));
    await write(
      join(dir, 'vendor-repo', 'package.json'),
      JSON.stringify({ name: 'vendor', scripts: { dev: 'node .' } }),
    );

    const result = await scanProjects(dir);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]?.source, 'git');
    assert.deepEqual(
      appsOf(result.projects).map((app) => app.name),
      ['root'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('项目判定：容器文件夹只展开一层直接子仓库，并带上容器信息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-container-'));
  try {
    await git(join(dir, 'group', 'repo-a'));
    await write(
      join(dir, 'group', 'repo-a', 'package.json'),
      JSON.stringify({ name: 'a', scripts: { dev: 'node .' } }),
    );
    await git(join(dir, 'group', 'repo-b'));
    await write(
      join(dir, 'group', 'repo-b', 'package.json'),
      JSON.stringify({ name: 'b', scripts: { dev: 'node .' } }),
    );
    // 第三层仓库不应该被展开
    await git(join(dir, 'group', 'repo-a', 'nested'));
    // 普通目录，既不是项目也不含仓库
    await mkdir(join(dir, 'group', 'notes'), { recursive: true });
    // 独立的项目
    await git(join(dir, 'standalone'));
    await write(
      join(dir, 'standalone', 'package.json'),
      JSON.stringify({ name: 'standalone', scripts: { dev: 'node .' } }),
    );

    const result = await scanProjects(dir);
    assert.deepEqual(
      result.projects.map((project) => ({
        name: project.name,
        container: project.container?.name,
      })),
      [
        { name: 'standalone', container: undefined },
        { name: 'repo-a', container: 'group' },
        { name: 'repo-b', container: 'group' },
      ],
    );
    assert.equal(appsOf(result.projects).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('项目判定：无 git 但有项目清单的根目录也是项目（source=manifest）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-manifest-'));
  try {
    await write(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'plain', scripts: { dev: 'node .' } }),
    );
    const result = await scanProjects(dir);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]?.source, 'manifest');
    assert.equal(result.projects[0]?.name, dir.split('/').pop());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Java Maven：聚合 POM 只把 Spring Boot 模块算成应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-maven-'));
  try {
    await git(dir);
    await write(
      join(dir, 'pom.xml'),
      `<project><artifactId>demo</artifactId><packaging>pom</packaging><modules>
        <module>web</module><module>lib</module>
      </modules></project>`,
    );
    await write(
      join(dir, 'web', 'pom.xml'),
      `<project><artifactId>demo-web</artifactId><build><plugins><plugin>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <configuration><mainClass>com.example.WebApplication</mainClass></configuration>
      </plugin></plugins></build></project>`,
    );
    await write(
      join(dir, 'lib', 'pom.xml'),
      `<project><artifactId>demo-lib</artifactId></project>`,
    );

    const result = await scanProjects(dir);
    const project = result.projects[0];
    assert.ok(project);
    const group = project.ecosystems.find((item) => item.id === 'java-maven');
    assert.ok(group, '应有 Java (Maven) 分组');
    assert.equal(group.name, 'Java (Maven)');
    assert.deepEqual(
      group.apps.map((app) => app.name),
      ['demo-web'],
    );
    assert.deepEqual(group.apps[0]?.args, ['-pl', 'web', 'spring-boot:run']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Node.js：pnpm workspace 展开工作区包，排除根包并按包管理器命名分组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-node-'));
  try {
    await git(dir);
    await write(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'root',
        private: true,
        scripts: { dev: 'pnpm -r dev' },
        workspaces: ['apps/*'],
      }),
    );
    await write(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await write(
      join(dir, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: '@demo/api', scripts: { dev: 'node server.js' } }),
    );
    await write(
      join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: '@demo/web', scripts: { start: 'vite' } }),
    );

    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'node-pnpm');
    assert.ok(group);
    assert.equal(group.name, 'Node.js (pnpm)');
    assert.deepEqual(group.apps.map((app) => [app.name, app.command, app.args.join(' ')]).sort(), [
      ['@demo/api', 'pnpm', 'run dev'],
      ['@demo/web', 'pnpm', 'run start'],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Node.js：同一项目里的不同包按各自 lockfile 分成 yarn / pnpm 两组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-node-managers-'));
  try {
    await git(dir);
    await write(
      join(dir, 'admin', 'package.json'),
      JSON.stringify({ name: 'admin', scripts: { dev: 'vite' } }),
    );
    await write(join(dir, 'admin', 'yarn.lock'), '');
    await write(
      join(dir, 'pc', 'package.json'),
      JSON.stringify({ name: 'pc', scripts: { dev: 'nuxt dev' } }),
    );
    await write(join(dir, 'pc', 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const result = await scanProjects(dir);
    const groups = result.projects[0]?.ecosystems ?? [];
    assert.deepEqual(groups.map((group) => group.name).sort(), [
      'Node.js (pnpm)',
      'Node.js (yarn)',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('混合项目：Java Maven + Node 两个生态分组同时出现', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-mixed-'));
  try {
    await git(dir);
    await write(
      join(dir, 'pom.xml'),
      `<project><artifactId>mall</artifactId><packaging>pom</packaging><modules><module>web</module></modules></project>`,
    );
    await write(
      join(dir, 'web', 'pom.xml'),
      `<project><artifactId>mall-web</artifactId><build><plugins><plugin>
        <artifactId>spring-boot-maven-plugin</artifactId><configuration><mainClass>com.example.Web</mainClass></configuration>
      </plugin></plugins></build></project>`,
    );
    await write(
      join(dir, 'admin', 'package.json'),
      JSON.stringify({ name: 'admin-ui', scripts: { dev: 'vite' } }),
    );
    await write(
      join(dir, 'pc', 'package.json'),
      JSON.stringify({ name: 'pc-ui', scripts: { dev: 'nuxt dev' } }),
    );

    const result = await scanProjects(dir);
    const names = (result.projects[0]?.ecosystems ?? []).map((group) => group.name).sort();
    assert.deepEqual(names, ['Java (Maven)', 'Node.js (npm)']);
    assert.equal(appsOf(result.projects).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PHP / Composer：Laravel artisan 识别为可运行应用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-php-'));
  try {
    await git(dir);
    await write(join(dir, 'composer.json'), JSON.stringify({ name: 'demo/php' }));
    await write(join(dir, 'artisan'), '<?php');
    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'php-composer');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.command, app.args.join(' ')]),
      [['php', 'artisan serve']],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PHP / Composer：子目录里的 ThinkPHP 应用也能识别（不依赖自定义启动脚本）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-thinkphp-'));
  try {
    await git(dir);
    await write(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }),
    );
    await write(
      join(dir, 'server', 'composer.json'),
      JSON.stringify({ name: 'topthink/think', require: { 'topthink/framework': '^6.0' } }),
    );
    await write(join(dir, 'server', 'think'), '#!/usr/bin/env php\n<?php\nnamespace think;\n');
    await write(join(dir, 'server', 'public', 'index.php'), '<?php');
    await write(join(dir, 'server', 'public', 'router.php'), '<?php');

    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'php-composer');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.name, app.dir, app.command, app.args.join(' ')]),
      [['server', join(dir, 'server'), 'php', 'think run --host=127.0.0.1 --port=8000']],
    );
    // 根上的 Node 应用不受影响，前后端同仓时两边都能被看见。
    assert.ok(result.projects[0]?.ecosystems.some((item) => item.id === 'node-npm'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PHP / Composer：没有框架入口时退回 public/ 的 PHP 内置服务器', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-php-builtin-'));
  try {
    await git(dir);
    await write(
      join(dir, 'composer.json'),
      JSON.stringify({ name: 'demo/php', require: { php: '>=8.0' } }),
    );
    await write(join(dir, 'public', 'index.php'), '<?php');
    await write(join(dir, 'public', 'router.php'), '<?php');

    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'php-composer');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.command, app.args.join(' ')]),
      [['php', '-S 127.0.0.1:8000 -t public public/router.php']],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Flutter：pubspec 依赖 flutter 时识别为 flutter run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-flutter-'));
  try {
    await git(dir);
    await write(
      join(dir, 'pubspec.yaml'),
      'name: demo_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
    await write(join(dir, 'lib', 'main.dart'), 'void main() {}');
    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'flutter-pub');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.name, app.command, app.args.join(' ')]),
      [['demo_app', 'flutter', 'run']],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Go：go.mod + cmd/*/main.go 识别为 go run ./cmd/<name>', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-go-'));
  try {
    await git(dir);
    await write(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
    await write(join(dir, 'cmd', 'api', 'main.go'), 'package main\nfunc main() {}\n');
    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'go-modules');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.name, app.args.join(' ')]),
      [['api', 'run ./cmd/api']],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Rust：workspace 成员带 src/main.rs 识别为 cargo run -p <name>', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-rust-'));
  try {
    await git(dir);
    await write(join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n');
    await write(join(dir, 'crates', 'demo', 'Cargo.toml'), '[package]\nname = "demo"\n');
    await write(join(dir, 'crates', 'demo', 'src', 'main.rs'), 'fn main() {}');
    const result = await scanProjects(dir);
    const group = result.projects[0]?.ecosystems.find((item) => item.id === 'rust-cargo');
    assert.ok(group);
    assert.deepEqual(
      group.apps.map((app) => [app.name, app.args.join(' ')]),
      [['demo', 'run -p demo']],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('忽略目录：node_modules 与隐藏目录不参与扫描', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-ignore-'));
  try {
    await git(dir);
    await write(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'root', scripts: { dev: 'node .' } }),
    );
    await write(
      join(dir, 'node_modules', 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', scripts: { dev: 'node .' } }),
    );
    await write(
      join(dir, '.hidden', 'package.json'),
      JSON.stringify({ name: 'hidden', scripts: { dev: 'node .' } }),
    );
    const result = await scanProjects(dir);
    assert.deepEqual(
      appsOf(result.projects).map((app) => app.name),
      ['root'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('项目判定：递归穿过非 git 目录，遇到 git 才停，容器取最近的非 git 祖先', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-deep-'));
  try {
    await mkdir(join(dir, 'outer', 'inner', 'repo'), { recursive: true });
    await git(join(dir, 'outer', 'inner', 'repo'));
    await write(
      join(dir, 'outer', 'inner', 'repo', 'package.json'),
      JSON.stringify({ name: 'deep', scripts: { dev: 'node .' } }),
    );
    // git 项目内部的嵌套仓库不再成为项目
    await git(join(dir, 'outer', 'inner', 'repo', 'vendor-repo'));

    const result = await scanProjects(dir);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0]?.name, 'repo');
    assert.equal(result.projects[0]?.container?.name, 'inner');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Node.js：tsup/tsc 的 --watch 构建监听不当作可运行服务', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dockyard-scan-watch-'));
  try {
    await git(dir);
    await write(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        private: true,
      }),
    );
    await write(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await write(
      join(dir, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: 'lib', scripts: { dev: 'tsup src/index.ts --watch' } }),
    );
    await write(
      join(dir, 'packages', 'api', 'package.json'),
      JSON.stringify({ name: 'api', scripts: { dev: 'tsx watch src/main.ts' } }),
    );

    const result = await scanProjects(dir);
    const apps = appsOf(result.projects);
    assert.deepEqual(
      apps.map((app) => app.name),
      ['api'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
