/*
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2017 - 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { ChangeEvent, createRef, CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import classnames from 'classnames';

import AccessibleButton from './AccessibleButton';
import { _t } from '../../../languageHandler';
import { Key } from "../../../Keyboard";
import { replaceableComponent } from "../../../utils/replaceableComponent";

interface IMenuOptionProps {
    children: ReactElement;
    highlighted?: boolean;
    dropdownKey: string;
    id?: string;
    inputRef?: Ref<HTMLDivElement>;
    onClick(dropdownKey: string): void;
    onMouseEnter(dropdownKey: string): void;
}

class MenuOption extends React.Component<IMenuOptionProps> {
    static defaultProps = {
        disabled: false,
    };

    private onMouseEnter = () => {
        this.props.onMouseEnter(this.props.dropdownKey);
    };

    private onClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.props.onClick(this.props.dropdownKey);
    };

    render() {
        const optClasses = classnames({
            mx_Dropdown_option: true,
            mx_Dropdown_option_highlight: this.props.highlighted,
        });

        return <div
            id={this.props.id}
            className={optClasses}
            onClick={this.onClick}
            onMouseEnter={this.onMouseEnter}
            role="option"
            aria-selected={this.props.highlighted}
            ref={this.props.inputRef}
        >
            { this.props.children }
        </div>;
    }
}

interface IProps {
    id: string;
    // ARIA label
    label: string;
    value?: string;
    className?: string;
    children: ReactElement[];
    // negative for consistency with HTML
    disabled?: boolean;
    // The width that the dropdown should be. If specified,
    // the dropped-down part of the menu will be set to this
    // width.
    menuWidth?: number;
    searchEnabled?: boolean;
    // Called when the selected option changes
    onOptionChange(dropdownKey: string): void;
    // Called when the value of the search field changes
    onSearchChange?(query: string): void;
    // Function that, given the key of an option, returns
    // a node representing that option to be displayed in the
    // box itself as the currently-selected option (ie. as
    // opposed to in the actual dropped-down part). If
    // unspecified, the appropriate child element is used as
    // in the dropped-down menu.
    getShortOption?(value: string): ReactNode;
}

interface IState {
    expanded: boolean;
    highlightedOption: string | null;
    searchQuery: string;
}

/*
 * Reusable dropdown select control, akin to react-select,
 * but somewhat simpler as react-select is 79KB of minified
 * javascript.
 */
@replaceableComponent("views.elements.Dropdown")
export default class Dropdown extends React.Component<IProps, IState> {
    private readonly buttonRef = createRef<HTMLDivElement>();
    private dropdownRootElement: HTMLDivElement = null;
    private ignoreEvent: MouseEvent = null;
    private childrenByKey: Record<string, ReactNode> = {};

    constructor(props: IProps) {
        super(props);

        this.reindexChildren(this.props.children);

        const firstChild = React.Children.toArray(props.children)[0] as ReactElement;

        this.state = {
            // True if the menu is dropped-down
            expanded: false,
            // The key of the highlighted option
            // (the option that would become selected if you pressed enter)
            highlightedOption: firstChild ? firstChild.key as string : null,
            // the current search query
            searchQuery: '',
        };

        // Listen for all clicks on the document so we can close the
        // menu when the user clicks somewhere else
        document.addEventListener('click', this.onDocumentClick, false);
    }

    componentWillUnmount() {
        document.removeEventListener('click', this.onDocumentClick, false);
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    UNSAFE_componentWillReceiveProps(nextProps) { // eslint-disable-line
        if (!nextProps.children || nextProps.children.length === 0) {
            return;
        }
        this.reindexChildren(nextProps.children);
        const firstChild = nextProps.children[0];
        this.setState({
            highlightedOption: firstChild ? firstChild.key : null,
        });
    }

    private reindexChildren(children: ReactElement[]): void {
        this.childrenByKey = {};
        React.Children.forEach(children, (child) => {
            this.childrenByKey[child.key] = child;
        });
    }

    private onDocumentClick = (ev: MouseEvent) => {
        // Close the dropdown if the user clicks anywhere that isn't
        // within our root element
        if (ev !== this.ignoreEvent) {
            this.setState({
                expanded: false,
            });
        }
    };

    private onRootClick = (ev: MouseEvent) => {
        // This captures any clicks that happen within our elements,
        // such that we can then ignore them when they're seen by the
        // click listener on the document handler, ie. not close the
        // dropdown immediately after opening it.
        // NB. We can't just stopPropagation() because then the event
        // doesn't reach the React onClick().
        this.ignoreEvent = ev;
    };

    private onInputClick = (ev: React.MouseEvent) => {
        if (this.props.disabled) return;

        if (!this.state.expanded) {
            this.setState({
                expanded: true,
            });
            ev.preventDefault();
        }
    };

    private close() {
        this.setState({
            expanded: false,
        });
        // their focus was on the input, its getting unmounted, move it to the button
        if (this.buttonRef.current) {
            this.buttonRef.current.focus();
        }
    }

    private onMenuOptionClick = (dropdownKey: string) => {
        this.close();
        this.props.onOptionChange(dropdownKey);
    };

    private onInputKeyDown = (e: React.KeyboardEvent) => {
        let handled = true;

        // These keys don't generate keypress events and so needs to be on keyup
        switch (e.key) {
            case Key.ENTER:
                this.props.onOptionChange(this.state.highlightedOption);
                // fallthrough
            case Key.ESCAPE:
                this.close();
                break;
            case Key.ARROW_DOWN:
                this.setState({
                    highlightedOption: this.nextOption(this.state.highlightedOption),
                });
                break;
            case Key.ARROW_UP:
                this.setState({
                    highlightedOption: this.prevOption(this.state.highlightedOption),
                });
                break;
            default:
                handled = false;
        }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    private onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        this.setState({
            searchQuery: e.currentTarget.value,
        });
        if (this.props.onSearchChange) {
            this.props.onSearchChange(e.currentTarget.value);
        }
    };

    private collectRoot = (e: HTMLDivElement) => {
        if (this.dropdownRootElement) {
            this.dropdownRootElement.removeEventListener('click', this.onRootClick, false);
        }
        if (e) {
            e.addEventListener('click', this.onRootClick, false);
        }
        this.dropdownRootElement = e;
    };

    private setHighlightedOption = (optionKey: string) => {
        this.setState({
            highlightedOption: optionKey,
        });
    };

    private nextOption(optionKey: string): string {
        const keys = Object.keys(this.childrenByKey);
        const index = keys.indexOf(optionKey);
        return keys[(index + 1) % keys.length];
    }

    private prevOption(optionKey: string): string {
        const keys = Object.keys(this.childrenByKey);
        const index = keys.indexOf(optionKey);
        return keys[(index - 1) % keys.length];
    }

    private scrollIntoView(node: Element) {
        if (node) {
            node.scrollIntoView({
                block: "nearest",
                behavior: "auto",
            });
        }
    }

    private getMenuOptions() {
        const options = React.Children.map(this.props.children, (child) => {
            const highlighted = this.state.highlightedOption === child.key;
            return (
                <MenuOption
                    id={`${this.props.id}__${child.key}`}
                    key={child.key}
                    dropdownKey={child.key as string}
                    highlighted={highlighted}
                    onMouseEnter={this.setHighlightedOption}
                    onClick={this.onMenuOptionClick}
                    inputRef={highlighted ? this.scrollIntoView : undefined}
                >
                    { child }
                </MenuOption>
            );
        });
        if (options.length === 0) {
            return [<div key="0" className="mx_Dropdown_option" role="option">
                { _t("No results") }
            </div>];
        }
        return options;
    }

    render() {
        let currentValue;

        const menuStyle: CSSProperties = {};
        if (this.props.menuWidth) menuStyle.width = this.props.menuWidth;

        let menu;
        if (this.state.expanded) {
            if (this.props.searchEnabled) {
                currentValue = (
                    <input
                        type="text"
                        autoFocus={true}
                        className="mx_Dropdown_option"
                        onKeyDown={this.onInputKeyDown}
                        onChange={this.onInputChange}
                        value={this.state.searchQuery}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-activedescendant={`${this.props.id}__${this.state.highlightedOption}`}
                        aria-owns={`${this.props.id}_listbox`}
                        aria-disabled={this.props.disabled}
                        aria-label={this.props.label}
                    />
                );
            }
            menu = (
                <div className="mx_Dropdown_menu" style={menuStyle} role="listbox" id={`${this.props.id}_listbox`}>
                    { this.getMenuOptions() }
                </div>
            );
        }

        if (!currentValue) {
            const selectedChild = this.props.getShortOption ?
                this.props.getShortOption(this.props.value) :
                this.childrenByKey[this.props.value];
            currentValue = <div className="mx_Dropdown_option" id={`${this.props.id}_value`}>
                { selectedChild }
            </div>;
        }

        const dropdownClasses = {
            mx_Dropdown: true,
            mx_Dropdown_disabled: this.props.disabled,
        };
        if (this.props.className) {
            dropdownClasses[this.props.className] = true;
        }

        // Note the menu sits inside the AccessibleButton div so it's anchored
        // to the input, but overflows below it. The root contains both.
        return <div className={classnames(dropdownClasses)} ref={this.collectRoot}>
            <AccessibleButton
                className="mx_Dropdown_input mx_no_textinput"
                onClick={this.onInputClick}
                aria-haspopup="listbox"
                aria-expanded={this.state.expanded}
                disabled={this.props.disabled}
                inputRef={this.buttonRef}
                aria-label={this.props.label}
                aria-describedby={`${this.props.id}_value`}
            >
                { currentValue }
                <span className="mx_Dropdown_arrow" />
                { menu }
            </AccessibleButton>
        </div>;
    }
}
