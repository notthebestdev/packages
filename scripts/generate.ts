import prompts from "prompts";
import fs from "fs/promises";
import { colorize } from "json-colorizer";
import * as pc from "picocolors";

void (async function () {
  const forkedResponse = await prompts({
    type: "confirm",
    name: "forked",
    message:
      "Before we continue, have you forked the repository and cloned it to your local machine?",
  });

  if (!forkedResponse.forked) {
    console.log(
      "Please fork the repository and clone it to your local machine before running this script.",
    );
    process.exit(1);
  }

  const nameResponse = await prompts({
    type: "text",
    name: "name",
    message: "What is the name of your package? (e.g. numo-awesome-package)",
    validate: (value) => {
      if (!value) {
        return "Please provide a name for your package.";
      }
      if (value.includes(" ")) {
        return "Package names cannot contain spaces. Please use hyphens instead.";
      }
      if (value.startsWith("@")) {
        return "Package names cannot start with @. Please do not include the @ in the name.";
      }
      return true;
    },
  });

  const descriptionResponse = await prompts({
    type: "text",
    name: "description",
    message: "What is the description of your package?",
    validate: (value) => {
      if (!value) {
        return "Please provide a description for your package.";
      }
      return true;
    },
  });

  const authorResponse = await prompts({
    type: "text",
    name: "author",
    message:
      "Who is the author of this package? Please use your GitHub username, and make sure you create the pull request with this username. (e.g. my-github-username)",
    validate: (value) => {
      if (!value) {
        return "Please provide the author of your package.";
      }
      if (value.includes(" ")) {
        return "GitHub usernames cannot contain spaces. Please use hyphens instead.";
      }
      if (value.startsWith("@")) {
        return "GitHub usernames cannot start with @. Please do not include the @ in the username.";
      }
      if (value.length > 39) {
        return "GitHub usernames cannot be longer than 39 characters. Please provide a valid GitHub username.";
      }
      return true;
    },
  });

  const versionResponse = await prompts({
    type: "text",
    name: "version",
    message: "What is the version of your package? (e.g. 1.0.0)",
    validate: (value) => {
      const semverRegex =
        /^(\d+\.)?(\d+\.)?(\*|\d+)(?:-([\da-z\-]+(?:\.[\da-z\-]+)*))?(?:\+([\da-z\-]+(?:\.[\da-z\-]+)*))?$/i;
      if (!semverRegex.test(value)) {
        return "Please provide a valid version number in the format x.y.z (e.g. 1.0.0).";
      }
      return true;
    },
  });

  const licenseResponse = await prompts({
    type: "text",
    name: "license",
    message: "What is the license of your package? (e.g. MIT)",
    validate: (value) => {
      if (!value) {
        return "Please provide a license for your package.";
      }
      return true;
    },
  });

  const repo = await prompts({
    type: "text",
    name: "repo",
    message:
      "What is the URL of your package's repository? (e.g. https://github.com/username/package.git)",
    validate: (value) => {
      if (!value.endsWith(".git")) {
        return "Please provide a valid git repository URL that ends with .git";
      }
      try {
        new URL(value);
      } catch (e) {
        return "Please provide a valid URL for the repository.";
      }
      return true;
    },
  });

  const metaJson = {
    name: `@${authorResponse.author}/${nameResponse.name}`,
    version: versionResponse.version,
    description: descriptionResponse.description,
    author: authorResponse.author,
    license: licenseResponse.license,
    repository: repo.repo,
  };

  console.log(
    "Great! Here is the metadata for your package. Please review it and make sure it is correct.\n",
  );
  console.log(colorize(JSON.stringify(metaJson, null, 2)));
  console.log("\n");

  const confirmResponse = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Is this information correct?",
  });

  if (!confirmResponse.confirm) {
    console.log(
      "Please run the script again and provide the correct information.",
    );
    process.exit(1);
  }

  const filePath = `./packages/@${authorResponse.author}/${nameResponse.name}/meta.json`;

  await fs.mkdir(filePath, {
    recursive: true,
  });
  await fs.writeFile(filePath, JSON.stringify(metaJson, null, 2));

  console.log(
    pc.bold(
      `🎉 Your package metadata has been saved to ${filePath}. Please commit and push this file to your repository, then open a pull request to the main repository to have your package added to the index!`,
    ),
  );
})();
