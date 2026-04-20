import { readFile } from "node:fs/promises";
import { Octokit } from "octokit";

type PullRequestEvent = {
    pull_request?: {
        number: number;
        user: {
            login: string;
        };
        head: {
            sha: string;
            repo: {
                name: string;
                owner: {
                    login: string;
                };
            };
        };
    };
    repository?: {
        name: string;
        owner: {
            login: string;
        };
    };
};

type PullFile = {
    filename: string;
    status: string;
};

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function updateCodeownersContent(existingContent: string, ownerLogin: string): string {
    const lines = existingContent.split(/\r?\n/);
    const ownerToken = `@${ownerLogin}`;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        if (line.startsWith("*")) {
            const parts = line.split(/\s+/);
            if (!parts.includes(ownerToken)) {
                parts.push(ownerToken);
            }
            lines[index] = parts.join(" ");
            return lines.join("\n");
        }
    }

    lines.push(`* ${ownerToken}`);
    return lines.join("\n");
}

async function main(): Promise<void> {
    const token = getRequiredEnv("GITHUB_TOKEN");
    const eventPath = getRequiredEnv("GITHUB_EVENT_PATH");

    const eventRaw = await readFile(eventPath, "utf8");
    const event = JSON.parse(eventRaw) as PullRequestEvent;

    if (!event.pull_request || !event.repository) {
        throw new Error("This bot only supports pull_request events.");
    }

    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    const pullNumber = event.pull_request.number;
    const authorLogin = event.pull_request.user.login;
    const headOwner = event.pull_request.head.repo.owner.login;
    const headRepo = event.pull_request.head.repo.name;
    const headSha = event.pull_request.head.sha;

    const octokit = new Octokit({ auth: token });

    const semverRegex =
        /^(\d+\.)?(\d+\.)?(\*|\d+)(?:-([\da-z\-]+(?:\.[\da-z\-]+)*))?(?:\+([\da-z\-]+(?:\.[\da-z\-]+)*))?$/i;
    const metaPathRegex = /^(?:packages\/)?@([^/]+)\/([^/]+)\/meta\.json$/;
    const requiredFields = [
        "name",
        "version",
        "description",
        "author",
        "license",
        "repository",
    ] as const;

    const errors: string[] = [];

    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
    });

    if (files.length === 0) {
        errors.push("No files were changed in this PR.");
    }

    const metaFiles: string[] = [];
    const allowedStatuses = new Set(["added", "modified"]);

    for (const file of files as PullFile[]) {
        if (!allowedStatuses.has(file.status)) {
            errors.push(
                `File ${file.filename} has unsupported status '${file.status}'.`,
            );
            continue;
        }

        if (!metaPathRegex.test(file.filename)) {
            errors.push(
                `Only package metadata files are allowed. Unexpected file: ${file.filename}.`,
            );
            continue;
        }

        metaFiles.push(file.filename);
    }

    if (metaFiles.length === 0) {
        errors.push(
            "No valid package metadata file found. Expected path: [packages/]@<author>/<package>/meta.json",
        );
    }

    for (const path of metaFiles) {
        const match = path.match(metaPathRegex);
        if (!match) {
            errors.push(`${path}: invalid metadata file path.`);
            continue;
        }

        const authorFromPath = match[1];
        const packageFromPath = match[2];

        const contentResponse = await octokit.rest.repos.getContent({
            owner: headOwner,
            repo: headRepo,
            path,
            ref: headSha,
        });

        if (
            Array.isArray(contentResponse.data) ||
            contentResponse.data.type !== "file" ||
            !contentResponse.data.content
        ) {
            errors.push(`${path}: unable to read file content.`);
            continue;
        }

        const raw = Buffer.from(
            contentResponse.data.content,
            "base64",
        ).toString("utf8");

        let meta: unknown;
        try {
            meta = JSON.parse(raw);
        } catch {
            errors.push(`${path}: invalid JSON.`);
            continue;
        }

        if (!isObject(meta)) {
            errors.push(`${path}: JSON root must be an object.`);
            continue;
        }

        for (const key of requiredFields) {
            if (!(key in meta)) {
                errors.push(`${path}: missing required field '${key}'.`);
            }
        }

        const name = meta.name;
        const version = meta.version;
        const description = meta.description;
        const author = meta.author;
        const license = meta.license;
        const repository = meta.repository;

        if (typeof name !== "string" || name.trim() === "") {
            errors.push(`${path}: 'name' must be a non-empty string.`);
        } else {
            const expectedName = `@${authorFromPath}/${packageFromPath}`;
            if (name !== expectedName) {
                errors.push(`${path}: name must be exactly '${expectedName}'.`);
            }
        }

        if (typeof author !== "string" || author.trim() === "") {
            errors.push(`${path}: 'author' must be a non-empty string.`);
        } else {
            if (author.includes(" ")) {
                errors.push(`${path}: author cannot contain spaces.`);
            }
            if (author.startsWith("@")) {
                errors.push(`${path}: author cannot start with '@'.`);
            }
            if (author.length > 39) {
                errors.push(
                    `${path}: author cannot be longer than 39 characters.`,
                );
            }
            if (author !== authorFromPath) {
                errors.push(
                    `${path}: author must match path author '${authorFromPath}'.`,
                );
            }
        }

        if (typeof description !== "string" || description.trim() === "") {
            errors.push(`${path}: 'description' must be a non-empty string.`);
        }

        if (typeof version !== "string" || !semverRegex.test(version)) {
            errors.push(`${path}: 'version' must be a valid semver (x.y.z).`);
        }

        if (typeof license !== "string" || license.trim() === "") {
            errors.push(`${path}: 'license' must be a non-empty string.`);
        }

        if (typeof repository !== "string" || !repository.endsWith(".git")) {
            errors.push(
                `${path}: repository must be a URL ending with '.git'.`,
            );
        } else {
            try {
                new URL(repository);
            } catch {
                errors.push(`${path}: repository must be a valid URL.`);
            }
        }

        if (packageFromPath.includes(" ")) {
            errors.push(`${path}: package folder name cannot contain spaces.`);
        }
        if (packageFromPath.startsWith("@")) {
            errors.push(`${path}: package folder name cannot start with '@'.`);
        }
    }

    const isValid = errors.length === 0;

    if (isValid) {
        const codeownersPath = ".github/CODEOWNERS";
        const codeownersResponse = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: codeownersPath,
        });

        if (
            !Array.isArray(codeownersResponse.data) &&
            codeownersResponse.data.type === "file"
        ) {
            const currentContent = Buffer.from(
                codeownersResponse.data.content || "",
                "base64",
            ).toString("utf8");
            const nextContent = updateCodeownersContent(currentContent, authorLogin);

            if (nextContent !== currentContent) {
                await octokit.rest.repos.createOrUpdateFileContents({
                    owner,
                    repo,
                    path: codeownersPath,
                    message: `chore: add @${authorLogin} to CODEOWNERS`,
                    content: Buffer.from(nextContent, "utf8").toString("base64"),
                    sha: codeownersResponse.data.sha,
                });
            }
        }
    }

    const body = isValid
        ? "Automated review passed. All changed package metadata files are valid according to scripts/generate.js."
        : [
              "Automated review failed. Please fix the following issue(s):",
              "",
              ...errors.map((error, index) => `${index + 1}. ${error}`),
          ].join("\n");

    if (isValid) {
        await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            event: "APPROVE",
            body,
        });
    } else {
        await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            event: "REQUEST_CHANGES",
            body,
        });
    }

    console.log(
        isValid
            ? "PR approved by validation bot."
            : "PR marked as changes requested by validation bot.",
    );
}

main().catch((error: unknown) => {
    if (error instanceof Error) {
        console.error(error.message);
    } else {
        console.error("Unknown error", error);
    }
    process.exit(1);
});
