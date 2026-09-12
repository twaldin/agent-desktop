import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icons";
import "./settings-sidebar.css";

import type { SettingsPage } from "../window-state";
export type { SettingsPage } from "../window-state";

// Pinned settings caller artwork, not the main sidebar's animated icon variants.
// General reuses Icon.settings; the remaining native canvases stay local to Settings.
const settingsIcons = {
  appearance: <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M9.33447 18.3336V16.6666C9.33447 16.2995 9.63239 16.0018 9.99951 16.0016C10.3668 16.0016 10.6646 16.2994 10.6646 16.6666V18.3336C10.6644 18.7007 10.3667 18.9987 9.99951 18.9987C9.6325 18.9985 9.33465 18.7006 9.33447 18.3336ZM5.28564 14.7145L5.75635 15.1842L4.57764 16.3629C4.31799 16.6225 3.89691 16.6224 3.63721 16.3629C3.37752 16.1032 3.37753 15.6822 3.63721 15.4225L4.81592 14.2438L5.28564 14.7145ZM16.3628 15.4225C16.6223 15.6822 16.6224 16.1033 16.3628 16.3629C16.1032 16.6226 15.6821 16.6224 15.4224 16.3629L16.3628 15.4225ZM16.3628 15.4225L15.8921 15.8922L15.4224 16.3629L14.2437 15.1842L14.7144 14.7145L15.1841 14.2438L16.3628 15.4225ZM4.81592 14.2438C5.07563 13.9843 5.49671 13.9841 5.75635 14.2438C6.01582 14.5034 6.01581 14.9245 5.75635 15.1842L4.81592 14.2438ZM14.2437 14.2438C14.5033 13.9841 14.9244 13.9841 15.1841 14.2438L14.2437 15.1842C13.984 14.9245 13.984 14.5035 14.2437 14.2438ZM12.6685 9.99963C12.6683 8.5261 11.4731 7.33167 9.99951 7.33167C8.52609 7.33184 7.33172 8.52621 7.33154 9.99963C7.33154 11.4732 8.52598 12.6684 9.99951 12.6686C11.4732 12.6686 12.6685 11.4733 12.6685 9.99963ZM3.3335 9.33459L3.46729 9.34827C3.77019 9.41027 3.99838 9.67844 3.99854 9.99963C3.99854 10.3209 3.77023 10.5889 3.46729 10.651L3.3335 10.6647H1.6665C1.29923 10.6647 1.00146 10.3669 1.00146 9.99963C1.00164 9.63251 1.29934 9.33459 1.6665 9.33459H3.3335ZM18.3335 9.33459L18.4673 9.34827C18.7702 9.41027 18.9984 9.67844 18.9985 9.99963C18.9985 10.3209 18.7702 10.5889 18.4673 10.651L18.3335 10.6647H16.6665C16.2992 10.6647 16.0015 10.3669 16.0015 9.99963C16.0016 9.63251 16.2993 9.33459 16.6665 9.33459H18.3335ZM5.75635 4.81604C6.01571 5.07577 6.01593 5.49688 5.75635 5.75647C5.49676 6.01605 5.07564 6.01583 4.81592 5.75647L5.75635 4.81604ZM15.1841 5.75647C14.9244 6.01594 14.5033 6.01595 14.2437 5.75647C13.984 5.49683 13.9841 5.07575 14.2437 4.81604L15.1841 5.75647ZM3.63721 3.63733C3.86449 3.41005 4.21501 3.38183 4.47314 3.55237L4.57764 3.63733L5.75635 4.81604L5.28564 5.28577L4.81592 5.75647L3.63721 4.57776L3.55225 4.47327C3.3817 4.21513 3.40992 3.86461 3.63721 3.63733ZM15.4224 3.63733C15.6821 3.37765 16.1031 3.37764 16.3628 3.63733C16.6223 3.89703 16.6224 4.31811 16.3628 4.57776L15.1841 5.75647L14.7144 5.28577L14.2437 4.81604L15.4224 3.63733ZM9.33447 3.33362V1.66663C9.33447 1.29947 9.63239 1.00176 9.99951 1.00159C10.3668 1.00159 10.6646 1.29936 10.6646 1.66663V3.33362C10.6644 3.70074 10.3667 3.99866 9.99951 3.99866C9.6325 3.99848 9.33465 3.70063 9.33447 3.33362ZM13.9985 9.99963C13.9985 12.2079 12.2077 13.9987 9.99951 13.9987C7.79144 13.9985 6.00146 12.2077 6.00146 9.99963C6.00164 7.79167 7.79155 6.00176 9.99951 6.00159C12.2076 6.00159 13.9984 7.79156 13.9985 9.99963Z" fill="currentColor"/></svg>,
  configuration: <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M9.06543 1.95123C9.66107 1.69076 10.3389 1.69071 10.9346 1.95123L15.9346 4.13873C16.7832 4.51008 17.3311 5.34917 17.3311 6.27545V10.5528C17.3309 14.6017 14.0489 17.8847 10 17.8848C5.95108 17.8846 2.66813 14.6017 2.66797 10.5528V6.27545C2.66797 5.34924 3.21695 4.51012 4.06543 4.13873L9.06543 1.95123ZM10.4014 3.16998C10.1456 3.05814 9.85444 3.05819 9.59863 3.16998L4.59863 5.35748C4.23427 5.51708 3.99805 5.87764 3.99805 6.27545V10.5528C3.99821 13.8671 6.68563 16.5546 10 16.5547C13.3144 16.5546 16.0008 13.8671 16.001 10.5528V6.27545C16.001 5.87756 15.7658 5.51703 15.4014 5.35748L10.4014 3.16998Z" fill="currentColor"/><path d="M13.4678 11.4318L13.333 11.4182H10.833C10.466 11.4183 10.1682 11.7162 10.168 12.0832C10.168 12.4504 10.4659 12.7481 10.833 12.7482H13.333L13.4678 12.7346C13.7706 12.6724 13.9981 12.4044 13.9981 12.0832C13.9979 11.7621 13.7706 11.494 13.4678 11.4318Z" fill="currentColor"/><path d="M7.65336 12.426C7.46431 12.7406 7.05607 12.8424 6.74125 12.6535C6.42646 12.4646 6.32395 12.0563 6.51274 11.7414L7.55668 10.0002L6.51274 8.25899C6.32395 7.94412 6.42646 7.53583 6.74125 7.34688C7.05607 7.15799 7.46431 7.25975 7.65336 7.57442L8.90336 9.6584C9.0296 9.86893 9.0296 10.1315 8.90336 10.342L7.65336 12.426Z" fill="currentColor"/></svg>,
  keyboard: <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.9951 7.33002C15.9951 6.61898 15.9942 6.12565 15.9629 5.74213C15.9398 5.46008 15.9021 5.27068 15.8506 5.12689L15.7949 4.99701C15.6409 4.69476 15.4068 4.44188 15.1191 4.26556L14.9932 4.19525C14.8352 4.11475 14.6237 4.05799 14.248 4.02728C13.8645 3.99595 13.3712 3.99506 12.6602 3.99506H7.33008C6.61904 3.99506 6.12571 3.99595 5.74219 4.02728C5.36648 4.05799 5.15508 4.11474 4.99707 4.19525C4.65183 4.37117 4.37124 4.65177 4.19531 4.99701C4.1148 5.15502 4.05805 5.36642 4.02734 5.74213C3.99601 6.12565 3.99512 6.61898 3.99512 7.33002V12.6601C3.99512 13.3711 3.99601 13.8645 4.02734 14.248C4.05805 14.6236 4.11481 14.8351 4.19531 14.9931L4.26563 15.1191C4.44194 15.4067 4.69482 15.6409 4.99707 15.7949L5.12695 15.8505C5.27074 15.902 5.46014 15.9398 5.74219 15.9628C6.12571 15.9942 6.61904 15.9951 7.33008 15.9951H12.6602C13.3712 15.9951 13.8645 15.9942 14.248 15.9628C14.6237 15.9321 14.8352 15.8754 14.9932 15.7949L15.1191 15.7245C15.4068 15.5482 15.6409 15.2953 15.7949 14.9931L15.8506 14.8632C15.9021 14.7194 15.9398 14.53 15.9629 14.248C15.9942 13.8645 15.9951 13.3711 15.9951 12.6601V7.33002ZM17.3252 12.6601C17.3252 13.3492 17.3258 13.9062 17.2891 14.3564C17.2563 14.757 17.1911 15.1178 17.0469 15.454L16.9805 15.5966C16.7149 16.1179 16.3105 16.5542 15.8145 16.8583L15.5967 16.9804C15.2201 17.1722 14.8142 17.2516 14.3564 17.289C13.9062 17.3258 13.3492 17.3251 12.6602 17.3251H7.33008C6.64099 17.3251 6.08403 17.3258 5.63379 17.289C5.23315 17.2563 4.87242 17.191 4.53613 17.0468L4.39356 16.9804C3.87229 16.7148 3.43595 16.3104 3.13184 15.8144L3.00977 15.5966C2.81795 15.22 2.73859 14.8142 2.70117 14.3564C2.66439 13.9062 2.66504 13.3492 2.66504 12.6601V7.33002C2.66504 6.64093 2.66439 6.08397 2.70117 5.63373C2.73858 5.17594 2.81796 4.77011 3.00977 4.39349C3.31321 3.79796 3.79802 3.31314 4.39356 3.00971C4.77017 2.8179 5.176 2.73852 5.63379 2.70111C6.08403 2.66433 6.64099 2.66498 7.33008 2.66498H12.6602C13.3492 2.66498 13.9062 2.66433 14.3564 2.70111C14.8142 2.73853 15.2201 2.81789 15.5967 3.00971L15.8145 3.13178C16.3105 3.43589 16.7149 3.87223 16.9805 4.39349L17.0469 4.53607C17.1911 4.87236 17.2563 5.23309 17.2891 5.63373C17.3258 6.08397 17.3252 6.64093 17.3252 7.33002V12.6601Z" fill="currentColor"/><path d="M7.42654 10.6038L9.90146 6.85396C10.1554 6.46917 10.7538 6.7207 10.6565 7.17136L10.3159 8.75002H12.2258C12.5577 8.75002 12.7564 9.11918 12.5736 9.3962L10.0987 13.1461C9.8447 13.5309 9.24637 13.2793 9.34362 12.8287L9.68427 11.25H7.7743C7.44238 11.25 7.24371 10.8809 7.42654 10.6038Z" fill="currentColor"/></svg>,
  connections: <svg className="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2.125C14.3492 2.125 17.875 5.65076 17.875 10C17.875 14.3492 14.3492 17.875 10 17.875C5.65076 17.875 2.125 14.3492 2.125 10C2.125 5.65076 5.65076 2.125 10 2.125ZM7.88672 10.625C7.94334 12.3161 8.22547 13.8134 8.63965 14.9053C8.87263 15.5194 9.1351 15.9733 9.39453 16.2627C9.65437 16.5524 9.86039 16.625 10 16.625C10.1396 16.625 10.3456 16.5524 10.6055 16.2627C10.8649 15.9733 11.1274 15.5194 11.3604 14.9053C11.7745 13.8134 12.0567 12.3161 12.1133 10.625H7.88672ZM3.40527 10.625C3.65313 13.2734 5.45957 15.4667 7.89844 16.2822C7.7409 15.997 7.5977 15.6834 7.4707 15.3486C6.99415 14.0923 6.69362 12.439 6.63672 10.625H3.40527ZM13.3633 10.625C13.3064 12.439 13.0059 14.0923 12.5293 15.3486C12.4022 15.6836 12.2582 15.9969 12.1006 16.2822C14.5399 15.467 16.3468 13.2737 16.5947 10.625H13.3633ZM12.1006 3.7168C12.2584 4.00235 12.4021 4.31613 12.5293 4.65137C13.0059 5.90775 13.3064 7.56102 13.3633 9.375H16.5947C16.3468 6.72615 14.54 4.53199 12.1006 3.7168ZM10 3.375C9.86039 3.375 9.65437 3.44756 9.39453 3.7373C9.1351 4.02672 8.87263 4.48057 8.63965 5.09473C8.22547 6.18664 7.94334 7.68388 7.88672 9.375H12.1133C12.0567 7.68388 11.7745 6.18664 11.3604 5.09473C11.1274 4.48057 10.8649 4.02672 10.6055 3.7373C10.3456 3.44756 10.1396 3.375 10 3.375ZM7.89844 3.7168C5.45942 4.53222 3.65314 6.72647 3.40527 9.375H6.63672C6.69362 7.56102 6.99415 5.90775 7.4707 4.65137C7.59781 4.31629 7.74073 4.00224 7.89844 3.7168Z"/></svg>,
  git: <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx={5.4165} cy={5} r={1.875} stroke="currentColor" strokeWidth={1.33}/><circle cx={5.4165} cy={15} r={1.875} stroke="currentColor" strokeWidth={1.33}/><circle cx={14.5833} cy={5} r={1.875} stroke="currentColor" strokeWidth={1.33}/><path d="M5.4165 6.66664V13.3333" stroke="currentColor" strokeWidth={1.33} strokeLinejoin="round"/><path d="M5.41658 12.5V11.6667C5.41658 10.7462 6.16278 10 7.08325 10H12.9166C13.8371 10 14.5833 9.25381 14.5833 8.33333V7.5" stroke="currentColor" strokeWidth={1.33} strokeLinejoin="round"/></svg>,
  plugins: <svg className="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M8.25031 1.46094C12.2175 1.46116 14.7053 4.56317 14.4573 8.11328C14.3646 9.44154 13.6395 10.4315 12.6556 10.834C11.7842 11.1903 10.7744 11.0568 9.95637 10.3848C9.43406 10.8255 8.8274 11.1141 8.19465 11.167C7.46206 11.2281 6.74478 10.9691 6.16535 10.3672L6.16145 10.3623C6.16145 10.3623 6.15859 10.3586 6.15656 10.3564C6.15204 10.3517 6.14556 10.344 6.13703 10.335C6.11976 10.3167 6.09427 10.29 6.06281 10.2568C5.9996 10.1901 5.90986 10.0966 5.80793 9.98926C5.60368 9.77412 5.34664 9.50307 5.1341 9.28125C4.86457 8.99958 4.87183 8.55158 5.15363 8.28027L5.31672 8.12207L4.72004 7.50195C4.5193 7.29309 4.52604 6.96077 4.73469 6.75977C4.94359 6.55869 5.27678 6.56454 5.47785 6.77344L6.07453 7.39355L7.51789 6.00391L6.92121 5.38379C6.72021 5.17497 6.72621 4.8427 6.93488 4.6416C7.14378 4.44052 7.47697 4.44638 7.67805 4.65527L8.27473 5.27539L8.44465 5.1123C8.72754 4.84001 9.17872 4.85048 9.44953 5.13477L10.4808 6.21777C11.074 6.8285 11.3084 7.55474 11.2132 8.28613C11.1518 8.75707 10.9544 9.20384 10.6683 9.60938C11.1897 10.0141 11.7752 10.0597 12.2581 9.8623C12.8307 9.6281 13.3423 9.01591 13.4105 8.04004C13.6191 5.05211 11.5645 2.51194 8.25031 2.51172C5.3194 2.51172 2.78634 4.7507 2.58918 7.57031C2.36888 10.7251 4.6005 13.3876 7.99836 13.3877C9.02878 13.3877 10.0514 13.1687 10.8314 12.7041C11.0805 12.5558 11.4027 12.6377 11.5511 12.8867C11.6992 13.1357 11.6174 13.4581 11.3685 13.6064C10.3813 14.1943 9.15795 14.4375 7.99836 14.4375C3.956 14.4374 1.28142 11.2234 1.54133 7.49805C1.77976 4.08387 4.81315 1.46094 8.25031 1.46094ZM6.12727 8.80176C6.27942 8.9613 6.43614 9.12597 6.56965 9.2666C6.67197 9.37438 6.76112 9.46823 6.82453 9.53516C6.856 9.56836 6.88138 9.59493 6.89875 9.61328L6.9261 9.6416C7.2937 10.0219 7.7023 10.154 8.10774 10.1201C8.52986 10.0848 8.998 9.86387 9.43293 9.44531C9.87269 9.02201 10.1181 8.56488 10.1722 8.14941C10.2235 7.75361 10.1099 7.34127 9.72492 6.94629L9.72102 6.94238L8.9261 6.10742L6.12727 8.80176Z" fill="currentColor"/></svg>,
  accounts: <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.585 10C16.585 6.3632 13.6368 3.41504 10 3.41504C6.3632 3.41504 3.41504 6.3632 3.41504 10C3.41504 11.9528 4.26592 13.7062 5.61621 14.9121C6.6544 13.6452 8.23235 12.835 10 12.835C11.7674 12.835 13.3447 13.6454 14.3828 14.9121C15.7334 13.7062 16.585 11.9531 16.585 10ZM10 14.165C8.67626 14.165 7.49115 14.7585 6.69531 15.6953C7.66679 16.2602 8.79525 16.585 10 16.585C11.2041 16.585 12.3316 16.2597 13.3027 15.6953C12.5069 14.759 11.3233 14.1651 10 14.165ZM11.835 8.5C11.835 7.48656 11.0134 6.66504 10 6.66504C8.98656 6.66504 8.16504 7.48656 8.16504 8.5C8.16504 9.51344 8.98656 10.335 10 10.335C11.0134 10.335 11.835 9.51344 11.835 8.5ZM17.915 10C17.915 14.3713 14.3713 17.915 10 17.915C5.62867 17.915 2.08496 14.3713 2.08496 10C2.08496 5.62867 5.62867 2.08496 10 2.08496C14.3713 2.08496 17.915 5.62867 17.915 10ZM13.165 8.5C13.165 10.248 11.748 11.665 10 11.665C8.25202 11.665 6.83496 10.248 6.83496 8.5C6.83496 6.75202 8.25202 5.33496 10 5.33496C11.748 5.33496 13.165 6.75202 13.165 8.5Z" fill="currentColor"/></svg>,
  environments: <svg className="icon" viewBox="0 0 21 21" fill="none" aria-hidden="true"><path d="M13.7 4.65906H6.70001C5.29988 4.65906 4.59982 4.65906 4.06504 4.93154C3.59463 5.17122 3.21218 5.55368 2.9725 6.02408C2.70001 6.55886 2.70001 7.25893 2.70001 8.65906V13.1591C2.70001 14.5592 2.70001 15.2593 2.9725 15.794C3.21218 16.2644 3.59463 16.6469 4.06504 16.8866C4.59982 17.1591 5.29988 17.1591 6.70001 17.1591H13.7C15.1001 17.1591 15.8002 17.1591 16.335 16.8866C16.8054 16.6469 17.1878 16.2644 17.4275 15.794C17.7 15.2593 17.7 14.5592 17.7 13.1591V8.65906C17.7 7.25893 17.7 6.55886 17.4275 6.02408C17.1878 5.55368 16.8054 5.17122 16.335 4.93154C15.8002 4.65906 15.1001 4.65906 13.7 4.65906Z" stroke="currentColor" strokeWidth={1.33} strokeLinecap="round" strokeLinejoin="round"/><path d="M6.86676 14.5691H13.5334" stroke="currentColor" strokeWidth={1.33} strokeLinecap="round" strokeLinejoin="round"/></svg>,
  search: <svg className="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M7.33057 1.98535C10.2484 1.98535 12.6136 4.3508 12.6138 7.26855C12.6138 8.58031 12.1346 9.77942 11.3433 10.7031L13.9897 13.3496C14.1655 13.5253 14.1655 13.8106 13.9897 13.9863C13.814 14.1621 13.5288 14.1621 13.353 13.9863L10.7017 11.335C9.78678 12.0942 8.61243 12.5518 7.33057 12.5518C4.41281 12.5516 2.04736 10.1864 2.04736 7.26855C2.04754 4.35091 4.41292 1.98553 7.33057 1.98535ZM7.33057 2.88574C4.90998 2.88592 2.94793 4.84796 2.94775 7.26855C2.94775 9.68929 4.90987 11.6522 7.33057 11.6523C9.75141 11.6523 11.7144 9.6894 11.7144 7.26855C11.7142 4.84786 9.75131 2.88574 7.33057 2.88574Z" fill="currentColor"/></svg>,
};

type SettingsItem = { id: SettingsPage; label: string; group: "Personal" | "Integrations" | "Coding"; icon: ReactNode; description: string };

// The pinned grouped caller orders Configuration before Keyboard shortcuts.
// Accounts is the required OMP provider page, not hosted application sign-in.
const settingsItems: SettingsItem[] = [
  { id: "general", label: "General", group: "Personal", icon: <Icon name="settings" />, description: "Notifications and interaction" },
  { id: "appearance", label: "Appearance", group: "Personal", icon: settingsIcons.appearance, description: "Theme and window appearance" },
  { id: "omp", label: "Configuration", group: "Personal", icon: settingsIcons.configuration, description: "Native OMP configuration" },
  { id: "keyboard-shortcuts", label: "Keyboard shortcuts", group: "Personal", icon: settingsIcons.keyboard, description: "Customize application keyboard shortcuts" },
  { id: "accounts", label: "Accounts", group: "Personal", icon: settingsIcons.accounts, description: "Provider accounts and sign-in" },
  { id: "plugins", label: "Plugins", group: "Integrations", icon: settingsIcons.plugins, description: "Native OMP plugins, MCP servers, skills and hooks" },
  { id: "connections", label: "Connections", group: "Coding", icon: settingsIcons.connections, description: "This Mac and other devices on your tailnet" },
  { id: "git", label: "Git", group: "Coding", icon: settingsIcons.git, description: "Branch and repository defaults" },
  { id: "environments", label: "Environments", group: "Coding", icon: settingsIcons.environments, description: "Project setup environments" },
];

export interface SettingsSidebarProps {
  page: SettingsPage;
  onSelect(page: SettingsPage): void;
  onBack(): void;
  hostControl?: ReactNode;
  environmentAvailable?: boolean;
}

export function SettingsSidebar({ page, onSelect, onBack, hostControl, environmentAvailable = false }: SettingsSidebarProps) {
  const [query, setQuery] = useState("");
  const [highlightedPage, setHighlightedPage] = useState<SettingsPage>();
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const keyboardNavigation = useRef<{ page: SettingsPage; element: HTMLElement } | undefined>(undefined);
  const entryPage = useRef(page);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    const search = query.trim().toLowerCase();
    return settingsItems.filter(item => (item.id !== "environments" || environmentAvailable)
      && (!search || `${item.label} ${item.description}`.toLowerCase().includes(search)));
  }, [environmentAvailable, query]);
  const highlighted = visible.find(item => item.id === highlightedPage);
  const changeQuery = (value: string) => { setQuery(value); setHighlightedPage(undefined); };
  const clearSearch = () => { changeQuery(""); searchInput.current?.focus(); };

  // A page may restore its own focus after loading. Settings entry and keyboard
  // navigation retain their origin until new input, another route, blur or exit.
  useEffect(() => {
    if (searchInput.current) keyboardNavigation.current = { page: entryPage.current, element: searchInput.current };
    const cancel = () => { keyboardNavigation.current = undefined; };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  useEffect(() => {
    const intent = keyboardNavigation.current;
    if (!intent) return;
    if (intent.page !== page) { keyboardNavigation.current = undefined; return; }
    let frame = 0;
    const restore = () => {
      if (keyboardNavigation.current !== intent || document.activeElement === intent.element) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (keyboardNavigation.current === intent && intent.element.isConnected && document.hasFocus()) intent.element.focus();
      });
    };
    document.addEventListener("focusin", restore);
    restore();
    return () => { cancelAnimationFrame(frame); document.removeEventListener("focusin", restore); };
  }, [page]);

  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const macMove = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) && event.ctrlKey && (event.key === "n" || event.key === "p");
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey && !macMove || event.altKey || event.shiftKey) return;
    if (event.key === "Escape" && query.length) { event.preventDefault(); clearSearch(); return; }
    if (!searching || !visible.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || macMove) {
      event.preventDefault();
      const index = highlighted ? visible.indexOf(highlighted) : -1;
      const direction = event.key === "ArrowDown" || event.key === "n" ? 1 : -1;
      const nextIndex = index < 0 ? direction > 0 ? 0 : visible.length - 1 : (index + direction + visible.length) % visible.length;
      const next = visible[nextIndex];
      setHighlightedPage(next?.id);
      if (next) results.current?.querySelector<HTMLElement>(`[data-settings-result="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && highlighted) {
      event.preventDefault();
      if (highlighted.id !== page) keyboardNavigation.current = { page: highlighted.id, element: event.currentTarget };
      onSelect(highlighted.id);
    }
  };
  const navigationKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-settings-page]") : null;
    if (!target) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-settings-page]"));
    const next = buttons[buttons.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    if (!searching) next?.click();
  };
  const row = (item: SettingsItem) => {
    const selected = item.id === page || item.id === "plugins" && page === "mcp";
    return <button key={item.id} id={`settings-destination-${item.id}`} data-settings-page={item.id} type="button"
      className={`settings-sidebar-item${selected ? " selected" : ""}`}
      aria-current={selected ? "page" : undefined} onClick={event => {
        if (event.detail === 0 && document.activeElement === event.currentTarget && item.id !== page) {
          keyboardNavigation.current = { page: item.id, element: event.currentTarget };
        }
        onSelect(item.id);
      }}>
      {item.icon}<span>{item.label}</span>
    </button>;
  };
  return <aside className="settings-sidebar" aria-label="Settings navigation">
    <div className="settings-sidebar-titlebar drag-region" aria-hidden="true"/>
    <button className="settings-sidebar-back" type="button" role="link" onClick={onBack}>
      <Icon name="browserBack" /><span>Back to app</span>
    </button>
    <div className="settings-sidebar-search">
      <span className="settings-sidebar-search-icon">{settingsIcons.search}</span>
      <input ref={searchInput} type="text" role="combobox" aria-expanded={searching} aria-autocomplete="list" aria-haspopup="listbox" autoComplete="off" value={query} onChange={event => changeQuery(event.target.value)}
        onKeyDown={searchKeyDown} placeholder="Search settings…" aria-label="Search settings"
        aria-controls={searching ? "settings-search-results" : undefined}
        aria-activedescendant={searching && highlighted ? `settings-destination-${highlighted.id}` : undefined} />
      {query.length > 0 && <button type="button" className="settings-sidebar-search-clear" aria-label="Clear settings search" onClick={clearSearch}><Icon name="close" /></button>}
    </div>
    <nav className="settings-sidebar-nav" aria-label="Settings" onKeyDown={navigationKeyDown}>
      {searching ? <div>
        <div ref={results} id="settings-search-results" role="listbox" aria-label="Matching settings" className="settings-sidebar-results">
          {visible.map(item => <div key={item.id} id={`settings-destination-${item.id}`} data-settings-result={item.id}
            role="option" aria-selected={item.id === highlighted?.id}
            className={`settings-sidebar-result${item.id === highlighted?.id ? " highlighted" : ""}`}
            onMouseEnter={() => setHighlightedPage(item.id)} onMouseDown={event => event.preventDefault()}
            onClick={() => {
              setHighlightedPage(item.id);
              if (searchInput.current) {
                searchInput.current.focus();
                if (item.id !== page) keyboardNavigation.current = { page: item.id, element: searchInput.current };
              }
              onSelect(item.id);
            }}>
            {item.icon}<span>{item.label}</span>
          </div>)}
        </div>
        {!visible.length && <p className="settings-sidebar-empty" role="status">No results found</p>}
      </div> : (["Personal", "Integrations", "Coding"] as const).map(group => {
        const items = visible.filter(item => item.group === group);
        if (!items.length) return null;
        return <section key={group} aria-labelledby={`settings-sidebar-${group.toLowerCase()}`}>
          <h2 id={`settings-sidebar-${group.toLowerCase()}`}>{group}</h2>
          <div className="settings-sidebar-items">{items.map(row)}</div>
        </section>;
      })}
    </nav>
    {hostControl && <div className="settings-sidebar-host">{hostControl}</div>}
  </aside>;
}
