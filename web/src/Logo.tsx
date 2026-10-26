import type { SVGProps } from "react";

// Marca do Mia: "M" alto à esquerda, "I" e "A" empilhados à direita, em traço
// grosso com cantos arredondados. Desenhada no espaço 0–440 × 0–410.
export const MARK_PATHS = {
  m: "M15 392V47Q15 15 47 15H185Q217 15 217 47V380Q217 397 200 397H187V57Q187 45 175 45H132V397H100V45H57Q45 45 45 57V397H32Q15 397 15 380Z",
  i: "M268 15H410A15 15 0 0 1 410 45H354V155H410A15 15 0 0 1 410 185H268A15 15 0 0 1 268 155H324V45H268A15 15 0 0 1 268 15Z",
  a: "M253 382V257Q253 227 283 227H395Q425 227 425 257V382A15 15 0 0 1 395 382V327H283V382A15 15 0 0 1 253 382ZM283 297H395V277Q395 257 375 257H303Q283 257 283 277Z",
};

export function MiaMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 440 412" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path d={MARK_PATHS.m} />
      <path d={MARK_PATHS.i} />
      <path d={MARK_PATHS.a} />
    </svg>
  );
}
