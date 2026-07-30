{ pkgs }:
pkgs.mkShell {
  packages = with pkgs; [
    actionlint
    cbmc
    clang
    cmake
    cargo
    git
    gnumake
    nixfmt
    rustc
    rustfmt
    shellcheck
  ];

  LANG = if pkgs.stdenv.hostPlatform.isDarwin then "en_US.UTF-8" else "C.UTF-8";
  LC_ALL = if pkgs.stdenv.hostPlatform.isDarwin then "en_US.UTF-8" else "C.UTF-8";
}
