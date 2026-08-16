#!/bin/bash

# Default installation path
INSTALL_PATH=".agents/skills/hive-mind-council"

# Check if an argument was provided
if [ -n "$1" ]; then
  INSTALL_PATH="$1"
fi

echo "Installing The Hive Skill to ${INSTALL_PATH}..."

# Create the directory
mkdir -p "$INSTALL_PATH"

# Copy the skill files
# Assuming this script is run from the root of the repository
if [ -d "skills/hive-mind-council" ]; then
  cp -r skills/hive-mind-council/* "$INSTALL_PATH/"
  echo "Installation complete."
else
  echo "Error: Directory 'skills/hive-mind-council' not found."
  echo "Please run this script from the root of the the-hive-skill repository."
  exit 1
fi
